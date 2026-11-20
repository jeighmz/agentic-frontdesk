import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { readConfig } from "../src/config.ts";
import { CallMonitor, cacheSlots, createMonitorRouter, MONITOR_LIMITS, type MonitorSlot, type SlotsView } from "../src/monitor.ts";
import type { VoiceHandler } from "../src/domain.ts";

const TOKEN = "monitor-test-token-0123456789";
const callSid = (suffix: string) => `CA${suffix.repeat(32).slice(0, 32)}`;

function echoHandler(overrides: Partial<{ transfer: boolean; end: boolean }> = {}): VoiceHandler {
  return {
    async handle(_callId, turn, speech) {
      return {
        reply: { message: speech ? `You said ${speech}` : "Welcome to the demo.", transfer: false, end: false, ...overrides },
        turn: turn + 1,
      };
    },
  };
}

async function fixture(t: test.TestContext, slots: SlotsView, handler: VoiceHandler = echoHandler()) {
  const monitor = new CallMonitor();
  const config = readConfig({
    PUBLIC_BASE_URL: "https://voice.example.com", TWILIO_AUTH_TOKEN: "synthetic-token", MONITOR_TOKEN: TOKEN,
  });
  const app = createApp(config, monitor.wrap(handler), undefined, createMonitorRouter(TOKEN, monitor, slots));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { monitor, origin, wrapped: monitor.wrap(handler) };
}

const demoSlots: MonitorSlot[] = [{
  id: "slot-1", clinic: "Demo Clinic", clinicId: "clinic_001", service: "physical_therapy",
  startsAt: "2026-11-20T15:00:00.000Z", endsAt: "2026-11-20T15:30:00.000Z",
  timeZone: "America/New_York", status: "available",
}];

test("monitor records transcripts with statuses, replay dedupe and bounded memory", async () => {
  const monitor = new CallMonitor(() => 1700000000000);
  const wrapped = monitor.wrap(echoHandler());
  await wrapped.handle(callSid("a"), 0, "");
  await wrapped.handle(callSid("a"), 1, "book option one");
  await wrapped.handle(callSid("a"), 1, "book option one"); // webhook replay must not duplicate
  let [call] = monitor.snapshot();
  assert.ok(call);
  assert.equal(call.status, "active");
  assert.equal(call.turns.length, 2);
  assert.deepEqual(call.turns.map((turn) => turn.caller), [null, "book option one"]);
  assert.equal(call.turns[0]?.agent, "Welcome to the demo.");

  await monitor.wrap(echoHandler({ transfer: true })).handle(callSid("b"), 0, "staff");
  await monitor.wrap(echoHandler({ end: true })).handle(callSid("c"), 0, "goodbye");
  await assert.rejects(monitor.wrap({ handle: async () => { throw new Error("boom"); } }).handle(callSid("d"), 0, "hi"));
  const statuses = Object.fromEntries(monitor.snapshot().map((entry) => [entry.callId, entry.status]));
  assert.equal(statuses[callSid("b")], "transfer");
  assert.equal(statuses[callSid("c")], "ended");
  assert.equal(statuses[callSid("d")], "failed");
  const endedBy = Object.fromEntries(monitor.snapshot().map((entry) => [entry.callId, entry.endedBy]));
  assert.equal(endedBy[callSid("a")], null);
  assert.equal(endedBy[callSid("b")], "agent");
  assert.equal(endedBy[callSid("c")], "agent");
  assert.equal(endedBy[callSid("d")], "system");
  const failed = monitor.snapshot().find((entry) => entry.callId === callSid("d"));
  assert.equal(failed?.turns[0]?.failed, true);
  assert.equal(failed?.turns[0]?.agent, null);

  // A mid-call failure must append, never erase the previous caller text.
  await assert.rejects(monitor.wrap({ handle: async () => { throw new Error("boom"); } }).handle(callSid("a"), 2, "confirm"));
  [call] = monitor.snapshot();
  assert.equal(call?.callId, callSid("a"));
  assert.equal(call?.status, "failed");
  assert.equal(call?.turns.length, 3);
  assert.deepEqual(call?.turns.map((turn) => turn.caller), [null, "book option one", "confirm"]);
  assert.equal(call?.turns[1]?.agent, "You said book option one");
  assert.equal(call?.turns[2]?.failed, true);

  for (let index = 0; index < MONITOR_LIMITS.maxCalls + 5; index += 1) {
    await wrapped.handle(callSid(index.toString(16)), 0, "hello");
  }
  assert.equal(monitor.snapshot().length, MONITOR_LIMITS.maxCalls);
  for (let turn = 0; turn < MONITOR_LIMITS.maxTurns + 10; turn += 1) {
    await wrapped.handle(callSid("e"), turn, `turn ${turn}`);
  }
  [call] = monitor.snapshot();
  assert.equal(call?.turns.length, MONITOR_LIMITS.maxTurns);
});

test("monitor routes require the token, serve the page and expose calls with slots", async (t) => {
  const f = await fixture(t, async () => demoSlots);
  await f.wrapped.handle(callSid("f"), 0, "");
  assert.equal((await fetch(`${f.origin}/monitor/api/state`)).status, 401);
  assert.equal((await fetch(`${f.origin}/monitor?token=wrong-token-0123456789`)).status, 401);
  assert.equal((await fetch(`${f.origin}/monitor/api/state`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).status, 200);

  const page = await fetch(`${f.origin}/monitor?token=${TOKEN}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Front Desk Monitor/);

  const response = await fetch(`${f.origin}/monitor/api/state?token=${TOKEN}`);
  const state = await response.json() as {
    syntheticDataOnly: boolean;
    calls: { callId: string; turns: { agent: string | null }[] }[];
    slots: MonitorSlot[];
  };
  assert.equal(state.syntheticDataOnly, true);
  assert.equal(state.calls[0]?.callId, callSid("f"));
  assert.equal(state.calls[0]?.turns[0]?.agent, "Welcome to the demo.");
  assert.deepEqual(state.slots, demoSlots);
});

test("slot lookup failures degrade to slots: null without hiding transcripts", async (t) => {
  const f = await fixture(t, async () => { throw new Error("cosmos down"); });
  await f.wrapped.handle(callSid("9"), 0, "");
  const response = await fetch(`${f.origin}/monitor/api/state?token=${TOKEN}`);
  assert.equal(response.status, 200);
  const state = await response.json() as { slots: null; calls: unknown[] };
  assert.equal(state.slots, null);
  assert.equal(state.calls.length, 1);
});

test("cached slot views coalesce polls, expire after the TTL and never cache failures", async () => {
  let clock = 0;
  let fetches = 0;
  let fail = false;
  const view = cacheSlots(async () => {
    fetches += 1;
    if (fail) throw new Error("cosmos down");
    return demoSlots;
  }, 10_000, () => clock);
  const [first, second] = await Promise.all([view(), view()]);
  assert.deepEqual(first, demoSlots);
  assert.deepEqual(second, demoSlots);
  clock += 9_999;
  await view();
  assert.equal(fetches, 1);
  clock += 2;
  await view();
  assert.equal(fetches, 2);
  clock += 20_000;
  fail = true;
  await assert.rejects(view(), /cosmos down/);
  fail = false;
  assert.deepEqual(await view(), demoSlots);
  assert.equal(fetches, 4);
});

test("transport end signals mark who hung up without reactivation by replayed webhooks", async () => {
  const monitor = new CallMonitor();
  const wrapped = monitor.wrap(echoHandler());
  await wrapped.handle(callSid("a"), 0, "");
  monitor.endCall(callSid("a"), "caller");
  let [call] = monitor.snapshot();
  assert.equal(call?.status, "ended");
  assert.equal(call?.endedBy, "caller");
  await wrapped.handle(callSid("a"), 1, "hello"); // late replay after hang-up
  [call] = monitor.snapshot();
  assert.equal(call?.status, "ended");
  assert.equal(call?.endedBy, "caller");
  monitor.endCall(callSid("z"), "agent"); // unknown calls are ignored
  assert.equal(monitor.snapshot().length, 1);
});

test("handler call context is captured per call and exposed in snapshots", async () => {
  const contexts = new Map<string, { patient: string | null; clinicId: string | null; service: string | null }>();
  const monitor = new CallMonitor();
  const wrapped = monitor.wrap(echoHandler(), (callId) => contexts.get(callId) ?? null);
  await wrapped.handle(callSid("a"), 0, "");
  assert.equal(monitor.snapshot()[0]?.context, null);
  contexts.set(callSid("a"), { patient: "Casey Demo", clinicId: "clinic_001", service: "physical_therapy" });
  await wrapped.handle(callSid("a"), 1, "patient one");
  await wrapped.handle(callSid("b"), 0, "");
  const byId = Object.fromEntries(monitor.snapshot().map((call) => [call.callId, call.context]));
  assert.deepEqual(byId[callSid("a")], { patient: "Casey Demo", clinicId: "clinic_001", service: "physical_therapy" });
  assert.equal(byId[callSid("b")], null);
});
