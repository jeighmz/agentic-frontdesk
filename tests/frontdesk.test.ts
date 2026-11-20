import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import twilio from "twilio";
import { createApp } from "../src/app.ts";
import { DemoKnowledge, DemoPlanner, MemoryStore } from "../src/adapters.ts";
import { readConfig } from "../src/config.ts";
import { Frontdesk } from "../src/frontdesk.ts";
import { StateConflict, seedState, type Planner } from "../src/domain.ts";

const now = Date.parse("2030-01-07T12:00:00Z");
const callId = `CA${"a".repeat(32)}`;
function setup(planner: Planner = new DemoPlanner()) {
  const store = new MemoryStore(seedState(new Date(now)));
  const frontdesk = new Frontdesk({
    store, planner, knowledge: new DemoKnowledge(),
    timeZone: "America/New_York", now: () => now,
  });
  return { store, frontdesk };
}

test("booking requires explicit confirmation and webhook replay cannot book twice", async () => {
  const { store, frontdesk } = setup();
  await frontdesk.handle(callId, 0, "");
  const proposed = await frontdesk.handle(callId, 1, "book slot-2");
  assert.match(proposed.reply.message, /Say yes to confirm/);
  assert.equal((await store.load()).state.appointments.length, 1);
  const confirmed = await frontdesk.handle(callId, 2, "yes");
  assert.match(confirmed.reply.message, /is booked/);
  assert.equal((await store.load()).state.appointments.length, 2);
  assert.deepEqual(await frontdesk.handle(callId, 2, "yes"), confirmed);
  assert.equal((await store.load()).state.appointments.length, 2);
});

test("declining a reschedule preserves the original appointment", async () => {
  const { store, frontdesk } = setup();
  await frontdesk.handle(callId, 0, "");
  await frontdesk.handle(callId, 1, "reschedule appointment-demo to slot-3");
  const result = await frontdesk.handle(callId, 2, "no");
  assert.match(result.reply.message, /No appointment was changed/);
  assert.equal((await store.load()).state.appointments[0]?.slotId, "slot-1");
});

test("rescheduling moves the original appointment and frees its old slot", async () => {
  const { store, frontdesk } = setup();
  await frontdesk.handle(callId, 0, "");
  await frontdesk.handle(callId, 1, "reschedule appointment-demo to slot-3");
  await frontdesk.handle(callId, 2, "yes");
  const state = (await store.load()).state;
  assert.equal(state.appointments.length, 1);
  assert.equal(state.appointments[0]?.id, "appointment-demo");
  assert.equal(state.appointments[0]?.slotId, "slot-3");
  const available = await frontdesk.handle(callId, 3, "availability");
  assert.match(available.reply.message, /Available demo slots: slot-1/);
});

test("a slot taken after a proposal is rejected at confirmation time", async () => {
  const { store, frontdesk } = setup();
  await frontdesk.handle(callId, 0, "");
  await frontdesk.handle(callId, 1, "book slot-2");
  const otherCall = `CA${"b".repeat(32)}`;
  await frontdesk.handle(otherCall, 0, "");
  await frontdesk.handle(otherCall, 1, "book slot-2");
  await frontdesk.handle(otherCall, 2, "yes");
  const rejected = await frontdesk.handle(callId, 2, "yes");
  assert.match(rejected.reply.message, /no longer available/);
  assert.equal((await store.load()).state.appointments.filter((item) => item.slotId === "slot-2").length, 1);
});

test("rescheduling rejects an appointment moved after the caller's proposal", async () => {
  const { store, frontdesk } = setup();
  await frontdesk.handle(callId, 0, "");
  await frontdesk.handle(callId, 1, "reschedule appointment-demo to slot-3");
  const otherCall = `CA${"b".repeat(32)}`;
  await frontdesk.handle(otherCall, 0, "");
  await frontdesk.handle(otherCall, 1, "reschedule appointment-demo to slot-4");
  await frontdesk.handle(otherCall, 2, "yes");
  const result = await frontdesk.handle(callId, 2, "yes");
  assert.match(result.reply.message, /appointment changed after your request/);
  assert.equal((await store.load()).state.appointments[0]?.slotId, "slot-4");
});

test("spoken slot numbers work and rebooking a freed slot keeps appointment IDs unique", async () => {
  const { store, frontdesk } = setup({
    decide: async (context) => {
      if (context.speech === "move new appointment") {
        const appointment = context.appointments.find((item) => item.id !== "appointment-demo");
        assert.ok(appointment);
        return { action: "reschedule", appointmentId: appointment.id, slotId: "slot-3", faqId: null };
      }
      return new DemoPlanner().decide(context);
    },
  });
  await frontdesk.handle(callId, 0, "");
  await frontdesk.handle(callId, 1, "book slot two");
  await frontdesk.handle(callId, 2, "yes");
  await frontdesk.handle(callId, 3, "move new appointment");
  await frontdesk.handle(callId, 4, "yes");
  await frontdesk.handle(callId, 5, "book slot 2");
  await frontdesk.handle(callId, 6, "yes");
  const appointments = (await store.load()).state.appointments;
  assert.equal(appointments.length, 3);
  assert.equal(new Set(appointments.map((item) => item.id)).size, 3);
});

test("optimistic concurrency rejects stale schedule writes", async () => {
  const { store } = setup();
  const first = await store.load();
  const stale = await store.load();
  await store.save(first.state, first.version);
  await assert.rejects(store.save(stale.state, stale.version), StateConflict);
});

test("fabricated model slot IDs cannot mutate appointments", async () => {
  const { store, frontdesk } = setup({
    decide: async () => ({ action: "book", slotId: "invented", appointmentId: null, faqId: null }),
  });
  await frontdesk.handle(callId, 0, "");
  const result = await frontdesk.handle(callId, 1, "book tomorrow");
  assert.match(result.reply.message, /no longer available/);
  assert.equal((await store.load()).state.calls[callId]?.pending, null);
});

test("expired proposed slots are not booked", async () => {
  const store = new MemoryStore(seedState(new Date(now)));
  let time = now;
  const frontdesk = new Frontdesk({
    store, planner: new DemoPlanner(), knowledge: new DemoKnowledge(),
    timeZone: "UTC", now: () => time,
  });
  time = Date.parse("2030-01-08T14:59:00Z");
  await frontdesk.handle(callId, 0, "");
  await frontdesk.handle(callId, 1, "book slot-2");
  time += 61_000;
  const result = await frontdesk.handle(callId, 2, "yes");
  assert.match(result.reply.message, /no longer available/);
  assert.equal((await store.load()).state.appointments.length, 1);
});

test("unknown FAQ IDs trigger handoff rather than invented answers", async () => {
  const { frontdesk } = setup({
    decide: async () => ({ action: "faq", faqId: "invented", slotId: null, appointmentId: null }),
  });
  await frontdesk.handle(callId, 0, "");
  const result = await frontdesk.handle(callId, 1, "what are your hours?");
  assert.equal(result.reply.transfer, true);
  assert.match(result.reply.message, /could not find approved information/);
});

test("FAQ responses quote retrieved content and identify the source", async () => {
  const { frontdesk } = setup();
  await frontdesk.handle(callId, 0, "");
  const result = await frontdesk.handle(callId, 1, "what are your hours?");
  assert.match(result.reply.message, /fictional clinic is open Monday through Friday/);
  assert.match(result.reply.message, /Source: Synthetic clinic hours/);
});

test("signed Twilio requests return Gather XML; unsigned and URL-tampered requests fail", async (t) => {
  const { frontdesk } = setup();
  const config = readConfig({
    PUBLIC_BASE_URL: "https://voice.example.com/",
    TWILIO_AUTH_TOKEN: "test-token-not-a-real-secret",
  });
  const server = createApp(config, frontdesk).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const params = { CallSid: callId };
  const post = (path: string, signature?: string) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(signature ? { "x-twilio-signature": signature } : {}),
    },
    body: new URLSearchParams(params),
  });
  assert.equal((await post("/voice")).status, 403);
  const signature = twilio.getExpectedTwilioSignature(
    config.TWILIO_AUTH_TOKEN, `${config.PUBLIC_BASE_URL}/voice`, params,
  );
  const response = await post("/voice", signature);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Gather.*action="https:\/\/voice.example.com\/voice\?turn=1"/);
  assert.equal((await post("/voice?turn=1", signature)).status, 403);

  const signedTurn = async (turn: number, speech: string) => {
    const path = `/voice?turn=${turn}`;
    const body = { CallSid: callId, SpeechResult: speech };
    const result = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          config.TWILIO_AUTH_TOKEN, `${config.PUBLIC_BASE_URL}${path}`, body,
        ),
      },
      body: new URLSearchParams(body),
    });
    assert.equal(result.status, 200);
    return result.text();
  };
  assert.match(await signedTurn(1, "book slot two"), /Say yes to confirm/);
  assert.match(await signedTurn(2, "yes"), /demo appointment is booked/);
  const loggedErrors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => loggedErrors.push(args));
  assert.match(await signedTurn(999, "unexpected turn"), /could not verify the result/);
  assert.equal(loggedErrors.length, 1);
  const failure = JSON.parse(String(loggedErrors[0]?.[0]));
  assert.equal(failure.event, "voice_request_failed");
  assert.equal(failure.category, "request_error");
  assert.equal(failure.error.type, "Error");
  assert.equal(failure.turn, 999);
  assert.ok(failure.requestId);
  assert.match(await signedTurn(3, "staff"), /No staff member has been contacted/);

  const handoffParams = { DialCallStatus: "busy" };
  const handoff = await fetch(`${origin}/voice/handoff`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        config.TWILIO_AUTH_TOKEN, `${config.PUBLIC_BASE_URL}/voice/handoff`, handoffParams,
      ),
    },
    body: new URLSearchParams(handoffParams),
  });
  assert.match(await handoff.text(), /could not complete the staff transfer/);
});
