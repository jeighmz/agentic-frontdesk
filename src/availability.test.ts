import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import twilio from "twilio";
import { Temporal } from "@js-temporal/polyfill";
import { generateAvailability, type AppointmentSlot } from "./availability.ts";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { ReferralFrontdesk } from "./referral-frontdesk.ts";
import { readAvailableSlots, type ReferralStore } from "./referral-store.ts";
import { generateClinics, generatePatients } from "./scripts/demo-data.ts";
import { insertMissingSlots } from "./scripts/seed-availability.ts";
import type { Patient } from "./referral-models.ts";

const asOf = "2026-11-18T23:00:00.000Z";
const now = Date.parse(asOf);
const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function fixture() {
  const clinics = generateClinics();
  const generated = generatePatients(clinics, 42, asOf);
  const patient = structuredClone(generated.find((item) =>
    item.referrals.length === 1 && item.referrals[0]?.status === "pending_contact"));
  assert.ok(patient);
  const referral = patient.referrals[0];
  assert.ok(referral);
  const clinic = clinics.find((item) => item.id === referral.destination_clinic_id);
  assert.ok(clinic);
  const slots = generateAvailability([clinic], asOf);
  const queries: { clinicId: string; service: string; time: number }[] = [];
  const records = new Map<string, Patient>([[patient.id, patient]]);
  const store: ReferralStore = {
    async patient(id) { return records.get(id) ?? null; },
    async clinic(id) {
      const found = clinics.find((item) => item.id === id);
      assert.ok(found);
      return found;
    },
    async availability(clinicId, service, time) {
      queries.push({ clinicId, service, time });
      return slots.filter((slot) => slot.clinic_id === clinicId && slot.service === service
        && slot.status === "available" && Date.parse(slot.starts_at) > time).slice(0, 3);
    },
  };
  const handler = new ReferralFrontdesk(store, () => now);
  return { clinics, patient, clinic, referral, slots, queries, store, records, handler };
}

test("availability generation respects clinic services, hours, closed days and unique deterministic IDs", () => {
  const clinics = generateClinics();
  const slots = generateAvailability(clinics, asOf);
  const firstDay = Temporal.Instant.from(asOf).toZonedDateTimeISO("America/New_York").toPlainDate().add({ days: 1 });
  const lastDay = firstDay.add({ days: 13 });
  assert.ok(slots.length > 1000);
  assert.deepEqual(generateAvailability(clinics, asOf), slots);
  assert.equal(new Set(slots.map((slot) => slot.id)).size, slots.length);
  for (const slot of slots) {
    const clinic = clinics.find((item) => item.id === slot.clinic_id);
    assert.ok(clinic);
    assert.ok(clinic.services.includes(slot.service));
    const start = Temporal.Instant.from(slot.starts_at).toZonedDateTimeISO(slot.time_zone);
    const end = Temporal.Instant.from(slot.ends_at).toZonedDateTimeISO(slot.time_zone);
    const weekday = weekdays[start.dayOfWeek - 1];
    assert.ok(weekday);
    const hours = clinic.hours[weekday];
    assert.ok(hours);
    const [opens, closes] = hours.split("-");
    assert.ok(opens && closes);
    assert.ok(start.toPlainTime().toString() >= `${opens}:00`);
    assert.ok(end.toPlainTime().toString() <= `${closes}:00`);
    assert.equal(end.epochMilliseconds - start.epochMilliseconds, 30 * 60_000);
    assert.ok(start.epochMilliseconds > now);
    assert.ok(Temporal.PlainDate.compare(start.toPlainDate(), firstDay) >= 0);
    assert.ok(Temporal.PlainDate.compare(start.toPlainDate(), lastDay) <= 0);
    assert.equal(start.toPlainDate().toString(), end.toPlainDate().toString());
    assert.equal(slot.status, "available");
    assert.ok(start.dayOfWeek !== 7);
  }
  assert.throws(() => generateAvailability([], asOf));
  assert.throws(() => generateAvailability(clinics, asOf, 0));
  assert.throws(() => generateAvailability(clinics, asOf, 31));
  const invalid = structuredClone(clinics[0]);
  assert.ok(invalid);
  invalid.hours.monday = "18:00-08:00";
  assert.throws(() => generateAvailability([invalid], asOf), /Invalid opening hours/);
});

test("local clinic hours remain correct across both daylight-saving transitions", () => {
  const clinic = generateClinics()[0];
  assert.ok(clinic);
  clinic.services = ["physical_therapy"];
  clinic.hours = { saturday: "08:00-09:00", sunday: "08:00-09:00" };
  const spring = generateAvailability([clinic], "2026-03-06T12:00:00Z", 2);
  assert.equal(spring[0]?.starts_at, "2026-03-07T13:00:00.000Z");
  assert.equal(spring[2]?.starts_at, "2026-03-08T12:00:00.000Z");
  const autumn = generateAvailability([clinic], "2026-10-30T12:00:00Z", 2);
  assert.equal(autumn[0]?.starts_at, "2026-10-31T12:00:00.000Z");
  assert.equal(autumn[2]?.starts_at, "2026-11-01T13:00:00.000Z");
});

test("slot seeding is create-only and preserves existing booked slots on reruns", async () => {
  const clinic = generateClinics()[0];
  assert.ok(clinic);
  const slots = generateAvailability([clinic], asOf, 1).slice(0, 3);
  const first = slots[0];
  assert.ok(first);
  const existing: AppointmentSlot = { ...first, status: "booked" };
  const documents = new Map([[first.id, existing]]);
  const container = {
    items: {
      async create(slot: AppointmentSlot) {
        if (documents.has(slot.id)) throw Object.assign(new Error("Conflict"), { code: 409 });
        documents.set(slot.id, structuredClone(slot));
      },
    },
  };
  assert.deepEqual(await insertMissingSlots(container, slots), { created: 2, existing: 1 });
  assert.deepEqual(await insertMissingSlots(container, slots), { created: 0, existing: 3 });
  assert.equal(documents.get(first.id)?.status, "booked");
  await assert.rejects(insertMissingSlots({
    items: { async create() { throw Object.assign(new Error("Forbidden"), { code: 403 }); } },
  }, slots), /Forbidden/);
});

test("Cosmos availability reads use the clinic partition and service/status/time filters", async () => {
  const { clinic, referral, slots } = fixture();
  const slot = slots.find((item) => item.service === referral.service);
  assert.ok(slot);
  const result = await readAvailableSlots({
    items: {
      query(query, options) {
        assert.deepEqual(options, { partitionKey: clinic.id });
        assert.match(query.query, /SELECT TOP 3/);
        assert.match(query.query, /c.status = "available"/);
        assert.match(query.query, /c.starts_at > @now/);
        assert.match(query.query, /ORDER BY c.starts_at ASC/);
        assert.ok(query.parameters?.some((parameter) => parameter.name === "@service" && parameter.value === referral.service));
        assert.ok(query.parameters?.some((parameter) => parameter.name === "@now" && parameter.value === asOf));
        return { async fetchAll() { return { resources: [slot] }; } };
      },
    },
  }, clinic.id, referral.service, now);
  assert.deepEqual(result, [slot]);
  for (const invalid of [
    { ...slot, clinic_id: "clinic_999" },
    { ...slot, status: "booked" },
    { ...slot, starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T12:30:00Z" },
    { ...slot, is_demo: false },
  ]) {
    await assert.rejects(readAvailableSlots({
      items: { query() { return { async fetchAll() { return { resources: [invalid] }; } }; } },
    }, clinic.id, referral.service, now));
  }
});

test("voice patient lookup reads the correct referral/clinic, replays turns and rejects booking", async () => {
  const { handler, patient, referral, clinic, queries } = fixture();
  const original = structuredClone(patient);
  const greeting = await handler.handle("call", 0, "");
  assert.match(greeting.reply.message, /booking is not enabled/);
  const result = await handler.handle("call", 1, patient.id);
  assert.match(result.reply.message, new RegExp(clinic.name));
  assert.match(result.reply.message, /Option 1/);
  assert.match(result.reply.message, /EST/);
  assert.deepEqual(queries, [{ clinicId: clinic.id, service: referral.service, time: now }]);
  assert.deepEqual(await handler.handle("call", 1, patient.id), result);
  assert.equal(queries.length, 1);
  const booking = await handler.handle("call", 2, "book option one");
  assert.match(booking.reply.message, /Nothing was changed or reserved/);
  assert.deepEqual(patient, original);
});

test("multiple active referrals require an explicit choice and terminal referrals are excluded", async () => {
  const { patient, referral, handler, records, queries } = fixture();
  patient.referrals = [
    { ...structuredClone(referral), referral_id: "ref_9001", status: "scheduled" },
    { ...structuredClone(referral), referral_id: "ref_9002" },
    { ...structuredClone(referral), referral_id: "ref_9003", source_hospital: "Demo Other Hospital" },
  ];
  records.set("patient_001", { ...patient, id: "patient_001", patient_id: "patient_001" });
  await handler.handle("call", 0, "");
  const choices = await handler.handle("call", 1, "patient one");
  assert.match(choices.reply.message, /Referral 1:/);
  assert.match(choices.reply.message, /Referral 2:/);
  assert.doesNotMatch(choices.reply.message, /Referral 3:/);
  assert.equal(queries.length, 0);
  const selected = await handler.handle("call", 2, "referral two");
  assert.match(selected.reply.message, /from Demo Other Hospital/);
  assert.equal(queries.length, 1);
  const current = records.get("patient_001");
  assert.ok(current?.referrals[2]);
  current.referrals[2].status = "declined";
  const refreshed = await handler.handle("call", 3, "availability");
  assert.match(refreshed.reply.message, /no longer active/);
});

test("empty, missing and inactive records produce explicit read-only outcomes", async () => {
  const { handler, patient, records, slots } = fixture();
  await handler.handle("call", 0, "");
  assert.match((await handler.handle("call", 1, "availability")).reply.message, /Say a demo patient number/);
  assert.match((await handler.handle("call", 2, "patient 100")).reply.message, /not found/);
  slots.length = 0;
  assert.match((await handler.handle("call", 3, patient.id)).reply.message, /no future demo slots are listed/);
  const referral = patient.referrals[0];
  assert.ok(referral);
  referral.status = "completed";
  records.set(patient.id, patient);
  assert.match((await handler.handle("call", 4, patient.id)).reply.message, /no active referrals/);
});

test("referral mode accepts Cosmos-only configuration and works through signed Twilio webhooks", async (t) => {
  const config = readConfig({
    MODE: "referrals", COSMOS_ENDPOINT: "https://cosmos.example.com",
    PUBLIC_BASE_URL: "https://voice.example.com", TWILIO_AUTH_TOKEN: "test-token",
  });
  assert.equal(config.MODE, "referrals");
  assert.throws(() => readConfig({
    MODE: "referrals", PUBLIC_BASE_URL: "https://voice.example.com", TWILIO_AUTH_TOKEN: "test-token",
  }));
  const { handler, patient, store } = fixture();
  const server = createApp(config, handler).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = async (turn: number, speech: string) => {
    const path = `/voice?turn=${turn}`;
    const body = { CallSid: `CA${"c".repeat(32)}`, SpeechResult: speech };
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
  assert.match(await post(0, ""), /fictional referral availability demo/);
  assert.match(await post(1, patient.id), /Option 1/);
  assert.match(await post(2, "yes"), /Nothing was changed or reserved/);
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  t.mock.method(store, "availability", async () => { throw new Error("Dependency unavailable"); });
  assert.match(await post(3, "availability"), /could not verify the result/);
  assert.equal(logs.length, 1);
});
