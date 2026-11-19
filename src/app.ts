import express from "express";
import twilio from "twilio";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { StateConflict, type Reply, type VoiceHandler } from "./domain.ts";
import { errorDetails, log, requestContext } from "./logging.ts";

const webhookSchema = z.object({
  CallSid: z.string().regex(/^CA[0-9a-f]{32}$/i),
  SpeechResult: z.string().max(2000).optional(),
});
const turnSchema = z.string().regex(/^\d{1,3}$/).transform(Number);

function voiceXml(config: Config, response: Reply, callTurn: number): string {
  const voice = new twilio.twiml.VoiceResponse();
  if (response.transfer) {
    voice.say(response.message);
    if (config.STAFF_PHONE_NUMBER) {
      voice.dial({ timeout: 20, action: `${config.PUBLIC_BASE_URL}/voice/handoff`, method: "POST" }, config.STAFF_PHONE_NUMBER);
    } else {
      voice.say("Staff transfer is not configured for this demo. No staff member has been contacted. Goodbye.");
      voice.hangup();
    }
  } else if (response.end) {
    voice.say(response.message);
    voice.hangup();
  } else {
    const gather = voice.gather({
      input: ["speech"],
      action: `${config.PUBLIC_BASE_URL}/voice?turn=${callTurn}`,
      method: "POST",
      language: "en-US",
      speechTimeout: "auto",
      timeout: 5,
      actionOnEmptyResult: true,
    });
    gather.say(response.message);
  }
  return voice.toString();
}

export function createApp(config: Config, frontdesk: VoiceHandler) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok", mode: config.MODE, syntheticDataOnly: true });
  });
  app.use("/voice", (request, response, next) => {
    const context = { requestId: randomUUID() };
    requestContext.run(context, () => {
      const start = performance.now();
      response.setHeader("x-request-id", context.requestId);
      log("info", "voice_request_started", {
        mode: config.MODE, method: request.method === "POST" ? "POST" : "other",
        route: request.path === "/" ? "voice" : request.path === "/handoff" ? "handoff" : "other",
      });
      const slow = setTimeout(() => {
        log("warn", "voice_request_slow", { durationMs: Math.round(performance.now() - start) });
      }, 8000);
      slow.unref();
      response.once("finish", () => {
        clearTimeout(slow);
        requestContext.run(context, () => {
          log("info", "voice_request_completed", {
            statusCode: response.statusCode, durationMs: Math.round(performance.now() - start),
          });
        });
      });
      response.once("close", () => {
        clearTimeout(slow);
        if (!response.writableFinished) requestContext.run(context, () => {
          log("warn", "voice_request_aborted", { durationMs: Math.round(performance.now() - start) });
        });
      });
      next();
    });
  });
  app.use("/voice", express.urlencoded({ extended: false, limit: "8kb" }));
  app.use("/voice", (request, response, next) => {
    const signature = request.get("x-twilio-signature") ?? "";
    const publicUrl = `${config.PUBLIC_BASE_URL}${request.originalUrl}`;
    if (!twilio.validateRequest(config.TWILIO_AUTH_TOKEN, signature, publicUrl, request.body ?? {})) {
      log("warn", "voice_request_rejected", { reason: "invalid_signature", statusCode: 403 });
      response.sendStatus(403);
      return;
    }
    next();
  });
  app.post("/voice", async (request, response) => {
    const body = webhookSchema.safeParse(request.body);
    const turn = turnSchema.safeParse(request.query.turn ?? "0");
    if (!body.success || !turn.success) {
      log("warn", "voice_request_rejected", { reason: "invalid_payload", statusCode: 400 });
      response.status(400).send("Invalid voice webhook");
      return;
    }
    const context = requestContext.getStore();
    if (context) context.turn = turn.data;
    log("info", "voice_turn_received", { speechPresent: Boolean(body.data.SpeechResult?.trim()) });
    const result = await frontdesk.handle(body.data.CallSid, turn.data, body.data.SpeechResult ?? "");
    response.type("text/xml").send(voiceXml(config, result.reply, result.turn));
  });
  app.post("/voice/handoff", (request, response) => {
    const voice = new twilio.twiml.VoiceResponse();
    voice.say(request.body?.DialCallStatus === "completed"
      ? "The staff call has ended. Goodbye."
      : "I could not complete the staff transfer. Please contact the hospital directly. For an emergency, call your local emergency number.");
    voice.hangup();
    response.type("text/xml").send(voice.toString());
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    log("error", "voice_request_failed", {
      category: error instanceof StateConflict ? "state_conflict" : "request_error",
      error: errorDetails(error),
    });
    response.status(200).type("text/xml").send(voiceXml(config, {
      message: "I could not verify the result of that request. Please ask staff to check the schedule before trying again.",
      transfer: true,
      end: false,
    }, 0));
  });
  return app;
}
