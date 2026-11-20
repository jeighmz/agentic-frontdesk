import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import twilio from "twilio";
import { WebSocket } from "ws";
import { z } from "zod";
import { createApp } from "./app.ts";
import { DemoKnowledge, DemoPlanner, MemoryStore } from "./adapters.ts";
import { readConfig } from "./config.ts";
import { ConversationRelay } from "./conversation-relay.ts";
import type { VoiceHandler } from "./domain.ts";
import { Frontdesk } from "./frontdesk.ts";
import { ModelUsageLimitError } from "./model-guard.ts";

const callId = `CA${"a".repeat(32)}`;
const accountId = `AC${"b".repeat(32)}`;
const outboundSchema = z.object({
  type: z.enum(["text", "end"]), token: z.string().optional(), last: z.boolean().optional(),
  interruptible: z.boolean().optional(), preemptible: z.boolean().optional(), handoffData: z.string().optional(),
});
type Message = z.infer<typeof outboundSchema>;

async function fixture(t: TestContext, options: {
  handler?: VoiceHandler;
  limitCall?: (account: string, call: string, seconds: number) => Promise<void>;
  staff?: string;
} = {}) {
  const logs: string[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    t.mock.method(console, method, (entry: string) => logs.push(entry));
  }
  const config = readConfig({
    VOICE_TRANSPORT: "relay", PUBLIC_BASE_URL: "https://voice.example.com",
    TWILIO_AUTH_TOKEN: "synthetic-token", STAFF_PHONE_NUMBER: options.staff ?? "",
  });
  const store = new MemoryStore();
  const frontdesk = options.handler ?? new Frontdesk({
    store, planner: new DemoPlanner(), knowledge: new DemoKnowledge(), timeZone: "America/New_York",
  });
  const calls: { turn: number; speech: string }[] = [];
  const handler: VoiceHandler = {
    async handle(id, turn, speech) {
      calls.push({ turn, speech });
      return frontdesk.handle(id, turn, speech);
    },
  };
  const limits: { account: string; call: string; seconds: number }[] = [];
  const relay = new ConversationRelay(config, handler, options.limitCall ?? (async (account, call, seconds) => {
    limits.push({ account, call, seconds });
  }));
  const server = createServer(createApp(config, handler, relay));
  relay.attach(server);
  server.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => {
    relay.close();
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  async function post(path: string, body: Record<string, string>, signed = true) {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signed
          ? twilio.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN, `${config.PUBLIC_BASE_URL}${path}`, body) : "invalid",
      },
      body: new URLSearchParams(body),
    });
  }
  function reservation(xml: string) {
    const socketUrl = xml.match(/url="([^"]+)"/)?.[1];
    const action = xml.match(/action="([^"]+)"/)?.[1];
    assert.ok(socketUrl && action);
    const url = new URL(socketUrl);
    const callback = new URL(action);
    return { xml, socketUrl, path: `${url.pathname}${url.search}`, callback: `${callback.pathname}${callback.search}` };
  }
  async function reserve(id = callId) {
    const response = await post("/voice", { CallSid: id });
    assert.equal(response.status, 200);
    return reservation(await response.text());
  }
  async function connect(reserved: ReturnType<typeof reservation>, scheme: "wss:" | "https:" = "wss:") {
    const ws = new WebSocket(`${origin.replace(/^http:/, "ws:")}${reserved.path}`, {
      headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          config.TWILIO_AUTH_TOKEN, reserved.socketUrl.replace(/^wss:/, scheme), {},
        ),
      },
    });
    const buffered: Message[] = [];
    const waiting: { resolve(value: Message): void; reject(error: Error): void }[] = [];
    ws.on("message", (data) => {
      const message = outboundSchema.parse(JSON.parse(data.toString()));
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(message);
      else buffered.push(message);
    });
    ws.on("close", () => {
      for (const waiter of waiting.splice(0)) waiter.reject(new Error("Socket closed before expected message"));
    });
    await once(ws, "open");
    const next = () => {
      const message = buffered.shift();
      return message ? Promise.resolve(message) : new Promise<Message>((resolve, reject) => waiting.push({ resolve, reject }));
    };
    const send = (message: object) => ws.send(JSON.stringify(message));
    const flush = async () => {
      const pong = once(ws, "pong");
      ws.ping();
      await pong;
    };
    return { ws, next, send, buffered, flush };
  }
  const setup = { type: "setup", callSid: callId, accountSid: accountId };
  return { config, relay, store, calls, limits, logs, origin, post, reserve, reservation, connect, setup };
}

test("relay is opt-in and rejects invalid transport or voice configuration", () => {
  const base = { PUBLIC_BASE_URL: "https://voice.example.com", TWILIO_AUTH_TOKEN: "synthetic-token" };
  assert.equal(readConfig(base).VOICE_TRANSPORT, "gather");
  assert.throws(() => readConfig({ ...base, VOICE_TRANSPORT: "unknown" }));
  assert.throws(() => readConfig({ ...base, ELEVENLABS_VOICE_ID: "not-a-voice-id" }));
  assert.throws(() => createApp(readConfig({ ...base, VOICE_TRANSPORT: "relay" }), {
    async handle() { throw new Error("Must not be called"); },
  }), /must be attached/);
});

test("signed relay admission is replay-safe, uses ElevenLabs and permits only one active call", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post("/voice", { CallSid: callId }, false)).status, 403);
  const first = await f.reserve();
  assert.match(first.xml, /ttsProvider="ElevenLabs"/);
  assert.match(first.xml, /voice="21m00Tcm4TlvDq8ikWAM-v4"/);
  assert.match(first.xml, /applicationReconnect="false"/);
  assert.match(first.xml, /events="tokens-played"/);
  assert.equal((await f.reserve()).xml, first.xml);
  const other = await f.post("/voice", { CallSid: `CA${"c".repeat(32)}` });
  const busy = await other.text();
  assert.match(busy, /<Reject reason="busy"\s*\/>/);
  assert.doesNotMatch(busy, /ConversationRelay|<Say/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.limits.length, 0);
  const rejected = new WebSocket(`${f.origin.replace(/^http:/, "ws:")}${first.path}`);
  rejected.on("error", () => {});
  const [, response] = await once(rejected, "unexpected-response");
  assert.equal(response.statusCode, 403);
  response.resume();
  rejected.terminate();
  const connection = await f.connect(first, "https:");
  connection.send(f.setup);
  assert.equal((await connection.next()).type, "text");
  assert.deepEqual(f.limits, [{ account: accountId, call: callId, seconds: 300 }]);
  assert.equal(f.calls.length, 1);
});

test("live text turns preserve explicit booking confirmation, interruption safety and staff handoff", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { staff: "+15555550199" });
  const reserved = await f.reserve();
  const c = await f.connect(reserved);
  c.send(f.setup);
  assert.match((await c.next()).token ?? "", /synthetic|fictional/i);
  c.send({ type: "prompt", voicePrompt: "book slot-2", last: false });
  c.send({ type: "interrupt", utteranceUntilInterrupt: "private partial transcript" });
  await setImmediate();
  assert.equal(f.calls.length, 1);
  c.send({ type: "prompt", voicePrompt: "book slot-2", last: true });
  assert.match((await c.next()).token ?? "", /Say yes to confirm/);
  assert.equal((await f.store.load()).state.appointments.length, 1);
  c.send({ type: "interrupt" });
  c.send({ type: "prompt", voicePrompt: "yes", last: true });
  assert.match((await c.next()).token ?? "", /is booked/);
  assert.equal((await f.store.load()).state.appointments.length, 2);
  c.send({ type: "prompt", voicePrompt: "staff", last: true });
  const transfer = await c.next();
  assert.equal(transfer.type, "text");
  assert.ok(transfer.token);
  assert.equal(transfer.interruptible, false);
  assert.equal(transfer.preemptible, false);
  c.send({ type: "info", name: "agentSpeaking", value: "off" });
  c.send({ type: "info", name: "tokensPlayed", value: "Earlier speech has finished. Goodbye." });
  c.send({ type: "prompt", voicePrompt: "yes", last: true });
  const split = Math.floor(transfer.token.length / 2);
  c.send({ type: "info", name: "tokensPlayed", value: transfer.token.slice(0, split) });
  await c.flush();
  assert.equal(c.buffered.length, 0);
  assert.equal(f.calls.length, 4);
  const busy = await (await f.post("/voice", { CallSid: `CA${"c".repeat(32)}` })).text();
  assert.match(busy, /<Reject reason="busy"/);
  c.send({ type: "info", name: "tokensPlayed", value: transfer.token.slice(split) });
  const end = await c.next();
  assert.equal(end.type, "end");
  assert.deepEqual(JSON.parse(end.handoffData ?? "{}"), { reason: "ended" });
  const callback = await f.post(reserved.callback, { CallSid: callId });
  const xml = await callback.text();
  assert.match(xml, /<Dial[^>]*timeLimit="300"/);
  assert.match(xml, /\+15555550199/);
  assert.doesNotMatch(xml, /<Gather|<Say/);
  const replay = await f.post(reserved.callback, { CallSid: callId });
  assert.doesNotMatch(await replay.text(), /<Dial|<Say/);
  for (const status of ["completed", "busy"]) {
    const handoff = await (await f.post("/voice/handoff", { DialCallStatus: status })).text();
    assert.match(handoff, /<Hangup\s*\/>/);
    assert.doesNotMatch(handoff, /<Say|ConversationRelay/);
  }
  assert.match(f.logs.join(), /relay_handoff_ended.*handoff_failed/);
  assert.deepEqual(f.calls.map(({ speech }) => speech), ["", "book slot-2", "yes", "staff"]);
  assert.ok(!f.logs.join().includes("private partial transcript"));
  assert.ok(!f.logs.join().includes(callId));
});

test("overlapping speech is explicitly rejected, never queued into a later confirmation", { timeout: 5000 }, async (t) => {
  const gate = Promise.withResolvers<void>();
  const f = await fixture(t, {
    handler: {
      async handle(_id, turn) {
        if (turn === 1) await gate.promise;
        return {
          reply: { message: turn === 0 ? "Welcome" : "Say yes to confirm", transfer: false, end: false },
          turn: turn + 1,
        };
      },
    },
  });
  const c = await f.connect(await f.reserve());
  c.send(f.setup);
  await c.next();
  c.send({ type: "prompt", voicePrompt: "book option one", last: true });
  c.send({ type: "prompt", voicePrompt: "yes", last: true });
  assert.match((await c.next()).token ?? "", /still checking.*repeat/);
  gate.resolve();
  assert.match((await c.next()).token ?? "", /Say yes/);
  assert.equal(f.calls.length, 2);
  assert.ok(!f.calls.some(({ speech }) => speech === "yes"));
});

test("failure to set Twilio's hard duration limit ends the relay before any frontdesk operation", { timeout: 5000 }, async (t) => {
  const secret = "private-provider-error";
  const f = await fixture(t, {
    limitCall: async () => { throw Object.assign(new Error(secret), { code: 20003, status: 403 }); },
  });
  const reserved = await f.reserve();
  const c = await f.connect(reserved);
  c.send(f.setup);
  assert.equal((await c.next()).type, "end");
  assert.equal(f.calls.length, 0);
  const xml = await (await f.post(reserved.callback, { CallSid: callId })).text();
  assert.match(xml, /<Hangup\s*\/>/);
  assert.doesNotMatch(xml, /<Dial|<Gather|<Say/);
  assert.ok(!f.logs.join().includes(secret));
  assert.match(f.logs.join(), /"statusCode":403/);
});

test("the five-minute deadline ends active and silent calls without resetting on webhook replay", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reserved = f.reservation(f.relay.start(callId));
  const c = await f.connect(reserved);
  c.send(f.setup);
  await c.next();
  t.mock.timers.tick(299_999);
  assert.equal(c.buffered.length, 0);
  assert.equal(f.relay.start(callId), reserved.xml);
  t.mock.timers.tick(1);
  const end = await c.next();
  assert.equal(JSON.parse(end.handoffData ?? "{}").reason, "duration_limit");
  const reply = f.relay.finish(callId, new URL(reserved.socketUrl).searchParams.get("ticket") ?? "");
  assert.equal(reply.end, true);
  assert.equal(reply.transfer, false);
  assert.match(reply.message, /five-minute.*verify/);
  assert.equal(f.calls.length, 1);
  t.mock.timers.reset();
});

test("a missing setup times out and releases the single reserved call slot", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.relay.start(callId);
  t.mock.timers.tick(15_000);
  t.mock.timers.tick(5_000);
  assert.match(f.relay.start(`CA${"c".repeat(32)}`), /ConversationRelay/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.limits.length, 0);
  t.mock.timers.reset();
});

test("invalid setup, malformed/provider messages and frame floods fail closed without leaking payloads", { timeout: 5000 }, async (t) => {
  for (const failure of ["setup", "malformed", "provider", "flood"]) {
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      const c = await f.connect(await f.reserve());
      if (failure === "setup") {
        c.send({ ...f.setup, callSid: `CA${"d".repeat(32)}` });
      } else {
        c.send(f.setup);
        await c.next();
        if (failure === "malformed") c.ws.send("private-invalid-json");
        else if (failure === "provider") c.send({ type: "error", description: "private-provider-description" });
        else for (let index = 0; index < 100; index += 1) c.send({ type: "info" });
      }
      assert.equal((await c.next()).type, "end");
      assert.equal(f.calls.length, failure === "setup" ? 0 : 1);
      assert.ok(!f.logs.join().includes("private-"));
    });
  }
});

test("model-guard failures use an explicit terminal voice response instead of reconnecting or retrying", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, {
    handler: { async handle() { throw new ModelUsageLimitError("process"); } },
  });
  const reserved = await f.reserve();
  const c = await f.connect(reserved);
  c.send(f.setup);
  const warning = await c.next();
  assert.equal(warning.type, "text");
  assert.match(warning.token ?? "", /AI request limit/);
  assert.match(warning.token ?? "", /No staff member has been contacted/);
  assert.equal(warning.interruptible, false);
  c.send({ type: "info", name: "tokensPlayed", value: warning.token });
  assert.equal((await c.next()).type, "end");
  const xml = await (await f.post(reserved.callback, { CallSid: callId })).text();
  assert.match(xml, /<Hangup\s*\/>/);
  assert.doesNotMatch(xml, /ConversationRelay|<Gather|<Say|<Dial/);
  assert.equal(f.calls.length, 1);
});

test("final playback cannot outlive its timeout or the original five-minute deadline", { timeout: 5000 }, async (t) => {
  for (const limit of ["playback", "duration"]) {
    await t.test(limit, async (t) => {
      const f = await fixture(t, {
        staff: "+15555550199",
        handler: {
          async handle(_id, turn) {
            return { reply: { message: turn ? "Transferring you to staff." : "Welcome.", transfer: turn > 0, end: false }, turn: turn + 1 };
          },
        },
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const reserved = f.reservation(f.relay.start(callId));
      const c = await f.connect(reserved);
      c.send(f.setup);
      await c.next();
      if (limit === "duration") t.mock.timers.tick(299_999);
      c.send({ type: "prompt", voicePrompt: "staff", last: true });
      assert.equal((await c.next()).type, "text");
      if (limit === "playback") {
        t.mock.timers.tick(29_999);
        await c.flush();
        assert.equal(c.buffered.length, 0);
      }
      t.mock.timers.tick(1);
      const end = await c.next();
      assert.equal(JSON.parse(end.handoffData ?? "{}").reason, limit === "playback" ? "playback_timeout" : "duration_limit");
      const result = f.relay.finish(callId, new URL(reserved.socketUrl).searchParams.get("ticket") ?? "");
      assert.equal(result.transfer, false);
      assert.equal(result.end, true);
      assert.equal(f.calls.length, 2);
      assert.match(f.relay.start(`CA${"c".repeat(32)}`), /ConversationRelay/);
      t.mock.timers.reset();
    });
  }
});

test("provider failure or disconnect during final speech cannot trigger a staff transfer or another voice", { timeout: 5000 }, async (t) => {
  for (const failure of ["provider", "disconnect"]) {
    await t.test(failure, async (t) => {
      const f = await fixture(t, {
        staff: "+15555550199",
        handler: {
          async handle() {
            return { reply: { message: "Transferring you to staff.", transfer: true, end: false }, turn: 1 };
          },
        },
      });
      const reserved = await f.reserve();
      const c = await f.connect(reserved);
      c.send(f.setup);
      assert.equal((await c.next()).type, "text");
      if (failure === "provider") {
        c.send({ type: "error", description: "private-provider-description" });
        assert.equal((await c.next()).type, "end");
      } else {
        const closed = once(c.ws, "close");
        c.ws.close();
        await closed;
      }
      const xml = await (await f.post(reserved.callback, { CallSid: callId })).text();
      assert.match(xml, /<Hangup\s*\/>/);
      assert.doesNotMatch(xml, /<Dial|<Say|ConversationRelay/);
      assert.equal(f.calls.length, 1);
      assert.ok(!f.logs.join().includes("private-"));
    });
  }
});
