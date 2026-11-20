import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Reply, VoiceHandler } from "./domain.ts";
import { errorDetails, log, requestContext } from "./logging.ts";
import { voiceFailureReply } from "./voice-replies.ts";

export const RELAY_LIMITS = { maxCalls: 1, maxCallSeconds: 300, maxMessages: 100 } as const;
const callSidSchema = z.string().regex(/^CA[0-9a-f]{32}$/i);
const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setup"), callSid: callSidSchema, accountSid: z.string().regex(/^AC[0-9a-f]{32}$/i) }),
  z.object({ type: z.literal("prompt"), voicePrompt: z.string().max(2000), last: z.boolean() }),
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("info"), name: z.string().optional(), value: z.unknown().optional() }),
  z.object({ type: z.literal("error") }),
]);
type Call = {
  id: string;
  ticket: string;
  requestId: string;
  turn: number;
  setup: boolean;
  providerLimited: boolean;
  busy: boolean;
  busyNotice: boolean;
  ending: boolean;
  messages: number;
  socket: WebSocket | null;
  reply: Reply;
  draining: { reply: Reply; played: string; expected: string; reason: "ended" | "provider_error" } | null;
  deadline: ReturnType<typeof setTimeout>;
  setupTimer: ReturnType<typeof setTimeout>;
  playbackTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};
type LimitCall = (accountSid: string, callSid: string, seconds: number) => Promise<void>;
export type RelayEndedBy = "caller" | "agent" | "system";

function ended(message: string): Reply {
  return { message, transfer: false, end: true };
}

export class ConversationRelay {
  private config: Config;
  private frontdesk: VoiceHandler;
  private limitCall: LimitCall;
  private active: Call | null = null;
  private seen = new Set<string>();
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  private detach: (() => void) | null = null;
  private closed = false;
  private onEnded: ((callId: string, by: RelayEndedBy) => void) | undefined;

  constructor(
    config: Config, frontdesk: VoiceHandler, limitCall?: LimitCall,
    onEnded?: (callId: string, by: RelayEndedBy) => void,
  ) {
    this.config = config;
    this.frontdesk = frontdesk;
    this.onEnded = onEnded;
    this.limitCall = limitCall ?? (async (accountSid, callSid, seconds) => {
      await twilio(accountSid, config.TWILIO_AUTH_TOKEN, { autoRetry: false, timeout: 3000 })
        .calls(callSid).update({ timeLimit: seconds });
    });
  }

  start(callId: string): string {
    const voice = new twilio.twiml.VoiceResponse();
    if (this.active?.id === callId && !this.active.ending && !this.active.draining) return this.connectXml(this.active);
    if (this.closed || this.active || this.seen.has(callId)) {
      log("warn", "relay_call_rejected", { reason: "capacity" });
      voice.reject({ reason: "busy" });
      return voice.toString();
    }
    this.seen.add(callId);
    if (this.seen.size > 100) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    const call: Call = {
      id: callId, ticket: randomUUID(), requestId: requestContext.getStore()?.requestId ?? randomUUID(),
      turn: 0, setup: false, providerLimited: false, busy: false, busyNotice: false, ending: false, messages: 0, socket: null,
      reply: ended("The real-time voice connection ended. If you were booking, ask staff to verify its status before trying again. Goodbye."),
      draining: null,
      deadline: setTimeout(() => this.end(call, ended(
        "The five-minute demo call limit has been reached. If you were booking, ask staff to verify its status before trying again. Goodbye.",
      ), "duration_limit"), RELAY_LIMITS.maxCallSeconds * 1000),
      setupTimer: setTimeout(() => this.end(call, ended(
        "I could not establish the real-time voice connection. Please contact the hospital directly. Goodbye.",
      ), "setup_timeout"), 15_000),
    };
    call.deadline.unref();
    call.setupTimer.unref();
    this.active = call;
    return this.connectXml(call);
  }

  finish(callId: string, ticket: string): Reply {
    const call = this.active;
    if (!call || call.id !== callId || call.ticket !== ticket) {
      return ended("The real-time voice session is no longer available. If you were booking, ask staff to verify its status. Goodbye.");
    }
    const reply = call.reply;
    this.release(call);
    return reply;
  }

  attach(server: Server): void {
    if (this.detach) throw new Error("ConversationRelay is already attached");
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const ticket = /^\/voice\/relay\?ticket=([0-9a-f-]{36})$/.exec(request.url ?? "")?.[1];
      const call = this.active;
      const signature = request.headers["x-twilio-signature"];
      const httpsUrl = `${this.config.PUBLIC_BASE_URL}${request.url ?? "/"}`;
      const validSignature = typeof signature === "string" && (
        twilio.validateRequest(this.config.TWILIO_AUTH_TOKEN, signature, httpsUrl.replace(/^https:/, "wss:"), {})
        || twilio.validateRequest(this.config.TWILIO_AUTH_TOKEN, signature, httpsUrl, {})
      );
      if (!ticket || !validSignature || !call || call.ending || call.socket || ticket !== call.ticket) {
        log("warn", "relay_call_rejected", { reason: "invalid_signature" });
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        call.socket = ws;
        ws.on("message", (data, binary) => {
          requestContext.run({ requestId: call.requestId, turn: call.turn }, () => {
            void this.receive(call, data.toString(), binary).catch((error: unknown) => this.fail(call, error));
          });
        });
        ws.on("error", (error) => this.fail(call, error));
        ws.on("close", () => {
          if (!call.ending) this.end(call, call.reply, "transport_closed");
        });
      });
    };
    server.on("upgrade", upgrade);
    this.detach = () => server.off("upgrade", upgrade);
  }

  close(): void {
    this.closed = true;
    this.detach?.();
    this.detach = null;
    if (this.active) this.release(this.active);
    this.sockets.close();
  }

  private connectXml(call: Call): string {
    const voice = new twilio.twiml.VoiceResponse();
    voice.connect({
      action: `${this.config.PUBLIC_BASE_URL}/voice/relay-ended?ticket=${call.ticket}`, method: "POST",
    }).conversationRelay({
      url: `${this.config.PUBLIC_BASE_URL.replace(/^https:/, "wss:")}/voice/relay?ticket=${call.ticket}`,
      language: "en-US", ttsProvider: "ElevenLabs", voice: `${this.config.ELEVENLABS_VOICE_ID}-v4`,
      transcriptionProvider: "Deepgram", speechModel: "nova-3",
      interruptible: "speech", preemptible: false, partialPrompts: false,
      reportInputDuringAgentSpeech: true, echoPromptFiltering: true,
      applicationReconnect: false, elevenlabsTextNormalization: "on",
      events: "tokens-played",
    });
    voice.hangup();
    return voice.toString();
  }

  private async receive(call: Call, data: string, binary: boolean): Promise<void> {
    if (this.active !== call || call.ending) return;
    if (binary || ++call.messages > RELAY_LIMITS.maxMessages) throw new Error("Invalid relay message or message limit reached");
    const message = messageSchema.parse(JSON.parse(data));
    if (message.type === "error") throw new Error("ConversationRelay reported a provider error");
    if (message.type === "setup") {
      if (call.setup || message.callSid !== call.id) throw new Error("Unexpected relay setup");
      call.setup = true;
      call.busy = true;
      await this.limitCall(message.accountSid, call.id, RELAY_LIMITS.maxCallSeconds);
      call.providerLimited = true;
      clearTimeout(call.setupTimer);
      if (call.ending || this.active !== call) return;
      log("info", "relay_session_started");
      await this.respond(call, "");
      return;
    }
    if (!call.setup) throw new Error("Relay setup is required before speech");
    if (call.draining) {
      if (message.type === "info" && message.name === "tokensPlayed" && typeof message.value === "string") {
        const draining = call.draining;
        // Match the entire final utterance, not a completion event for earlier speech.
        draining.played = (draining.played + message.value.replace(/\s/g, "")).slice(-draining.expected.length);
        if (draining.played === draining.expected) this.end(call, draining.reply, draining.reason);
      }
      return;
    }
    if (message.type !== "prompt" || !message.last) return;
    if (call.busy) {
      log("warn", "relay_input_rejected", { reason: "busy" });
      if (!call.busyNotice) {
        call.busyNotice = true;
        this.send(call, { type: "text", token: "One moment, I am still checking. Please repeat your request after my response.", last: true });
      }
      return;
    }
    call.busy = true;
    await this.respond(call, message.voicePrompt);
  }

  private async respond(call: Call, speech: string): Promise<void> {
    try {
      const result = await this.frontdesk.handle(call.id, call.turn, speech);
      if (this.active !== call || call.ending) return;
      call.turn = result.turn;
      if (result.reply.end || result.reply.transfer) this.speakEnd(call, result.reply, "ended");
      else this.send(call, { type: "text", token: result.reply.message, last: true, interruptible: call.turn > 1 });
    } catch (error) {
      log("error", "relay_session_failed", { error: errorDetails(error) });
      this.speakEnd(call, voiceFailureReply(error), "provider_error");
    } finally {
      call.busy = false;
      call.busyNotice = false;
    }
  }

  private speakEnd(call: Call, reply: Reply, reason: "ended" | "provider_error"): void {
    if (this.active !== call || call.ending || call.draining) return;
    if (reply.transfer && !this.config.STAFF_PHONE_NUMBER) {
      reply = ended(`${reply.message} Staff transfer is not configured for this demo. No staff member has been contacted. Goodbye.`);
    }
    call.draining = { reply, played: "", expected: reply.message.replace(/\s/g, ""), reason };
    call.playbackTimer = setTimeout(() => {
      log("warn", "relay_session_failed", { reason: "playback_timeout" });
      this.end(call, ended("Final speech could not be verified. Ask staff to verify any booking before trying again."), "playback_timeout");
    }, 30_000);
    call.playbackTimer.unref();
    this.send(call, { type: "text", token: reply.message, last: true, interruptible: false, preemptible: false });
  }

  private send(call: Call, message: object): void {
    if (call.socket?.readyState === WebSocket.OPEN) {
      call.socket.send(JSON.stringify(message), (error) => { if (error) this.fail(call, error); });
    }
  }

  private fail(call: Call, error: unknown): void {
    log("error", "relay_session_failed", { error: errorDetails(error) });
    // A failure during final speech must never escalate to a transfer or more speech.
    if (call.draining) {
      this.end(call, ended("Final speech could not be verified. Ask staff to verify any booking before trying again."), "provider_error");
      return;
    }
    this.end(call, call.providerLimited ? ended(voiceFailureReply(error).message)
      : ended("The real-time voice connection could not be established. Please contact the hospital directly. Goodbye."), "provider_error");
  }

  private end(call: Call, reply: Reply, reason: "duration_limit" | "setup_timeout" | "transport_closed" | "ended" | "provider_error" | "playback_timeout"): void {
    if (this.active !== call || call.ending) return;
    call.ending = true;
    call.reply = reply;
    call.draining = null;
    clearTimeout(call.deadline);
    clearTimeout(call.setupTimer);
    clearTimeout(call.playbackTimer);
    log("info", "relay_session_ended", { reason });
    this.onEnded?.(call.id, reason === "ended" ? "agent" : reason === "transport_closed" ? "caller" : "system");
    this.send(call, { type: "end", handoffData: JSON.stringify({ reason }) });
    call.cleanupTimer = setTimeout(() => this.release(call), 5_000);
    call.cleanupTimer.unref();
  }

  private release(call: Call): void {
    clearTimeout(call.deadline);
    clearTimeout(call.setupTimer);
    clearTimeout(call.playbackTimer);
    clearTimeout(call.cleanupTimer);
    call.ending = true;
    call.socket?.terminate();
    if (this.active === call) this.active = null;
  }
}
