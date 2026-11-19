import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import twilio from "twilio";
import { Temporal } from "@js-temporal/polyfill";
import {
  availabilityWindows, generateAvailability, type AppointmentSlot, type AvailabilityWindow,
} from "./availability.ts";
import { createApp } from "./app.ts";
import { bookReferral, type BookingRequest } from "./booking.ts";
import { readConfig } from "./config.ts";
import { ReferralFrontdesk } from "./referral-frontdesk.ts";
import { readAvailableSlots, readPatientsByFullName, type ReferralStore } from "./referral-store.ts";
import { generateClinics, generatePatients } from "./scripts/demo-data.ts";
import { insertMissingSlots } from "./scripts/seed-availability.ts";
import { normalizePatientFullName, type Patient } from "./referral-models.ts";
import { memoryBookingDocuments } from "./test-support/booking-documents.ts";
import type { ReferralInterpreter } from "./referral-interpreter.ts";

const asOf = "2026-11-18T23:00:00.000Z";
const now = Date.parse(asOf);
const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function fixture(interpreter?: ReferralInterpreter) {
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
    async patientsByFullName(fullName) {
      return [...records.values()].filter((item) =>
        normalizePatientFullName(`${item.first_name} ${item.last_name}`) === normalizePatientFullName(fullName)).slice(0, 2);
    },
    async clinic(id) {
      const found = clinics.find((item) => item.id === id);
      assert.ok(found);
      return found;
    },
    async availability(clinicId, service, time, windows: AvailabilityWindow[] = []) {
      queries.push({ clinicId, service, time });
      return slots.filter((slot) => slot.clinic_id === clinicId && slot.service === service
        && slot.status === "available" && Date.parse(slot.starts_at) > time
        && (!windows.length || windows.some((window) => slot.starts_at >= window.start && slot.starts_at < window.end))).slice(0, 3);
    },
    async book(request) {
      const memory = memoryBookingDocuments(clinics, [...records.values()], slots);
      try {
        return await bookReferral(memory.documents, request, () => now);
      } finally {
        for (const id of records.keys()) records.set(id, memory.storedPatient(id));
        slots.splice(0, slots.length, ...slots.map((slot) => memory.storedSlot(slot.id, slot.clinic_id)));
      }
    },
  };
  const handler = new ReferralFrontdesk(store, () => now, interpreter);
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

test("availability preferences use New York calendar windows, including daylight-saving changes", () => {
  assert.deepEqual(availabilityWindows({ date: "2026-11-19", period: "afternoon" }, now), [{
    start: "2026-11-19T17:00:00.000Z", end: "2026-11-19T22:00:00.000Z",
  }]);
  assert.deepEqual(availabilityWindows({ date: "2026-11-01", period: "morning" }, Date.parse("2026-10-30T12:00:00Z")), [{
    start: "2026-11-01T04:00:00.000Z", end: "2026-11-01T17:00:00.000Z",
  }]);
  assert.deepEqual(availabilityWindows({ date: "2026-03-08", period: "morning" }, Date.parse("2026-03-06T12:00:00Z")), [{
    start: "2026-03-08T05:00:00.000Z", end: "2026-03-08T16:00:00.000Z",
  }]);
  assert.equal(availabilityWindows({ date: null, period: "afternoon" }, now).length, 31);
  assert.throws(() => availabilityWindows({ date: "2026-11-17", period: null }, now), RangeError);
  assert.throws(() => availabilityWindows({ date: "2027-01-01", period: null }, now), RangeError);
});

test("Cosmos applies preferred windows before TOP 3 and rejects results outside them", async () => {
  const { clinic, referral, slots } = fixture();
  const windows = availabilityWindows({ date: "2026-11-20", period: "afternoon" }, now);
  const window = windows[0];
  assert.ok(window);
  const matching = slots.filter((slot) => slot.service === referral.service
    && slot.starts_at >= window.start && slot.starts_at < window.end).slice(0, 3);
  assert.equal(matching.length, 3);
  const reader = (resources: AppointmentSlot[]) => ({
    items: { query(query: import("@azure/cosmos").SqlQuerySpec, options: { partitionKey: string }) {
      assert.equal(options.partitionKey, clinic.id);
      assert.match(query.query, /c.starts_at >= @start0 AND c.starts_at < @end0/);
      assert.ok(query.query.indexOf("@start0") < query.query.indexOf("ORDER BY"));
      assert.ok(query.parameters?.some((parameter) => parameter.name === "@start0" && parameter.value === window.start));
      assert.ok(query.parameters?.some((parameter) => parameter.name === "@end0" && parameter.value === window.end));
      return { async fetchAll() { return { resources }; } };
    } },
  });
  assert.deepEqual(await readAvailableSlots(reader(matching), clinic.id, referral.service, now, windows), matching);
  const outside = slots.find((slot) => slot.service === referral.service && slot.starts_at < window.start);
  assert.ok(outside);
  await assert.rejects(readAvailableSlots(reader([outside]), clinic.id, referral.service, now, windows));
});

test("natural-language preferences and slot selections still require deterministic confirmation", async (t) => {
  const contexts: import("./referral-interpreter.ts").ReferralContext[] = [];
  const f = fixture({
    async interpret(context) {
      contexts.push(context);
      return context.speech.includes("Friday")
        ? { action: "availability", date: "2026-11-20", period: "afternoon" }
        : { action: "choose_slot", choice: 2 };
    },
  });
  t.mock.method(console, "log", () => {});
  const booking = t.mock.method(f.store, "book");
  await f.handler.handle("call", 0, "");
  await f.handler.handle("call", 1, f.patient.id);
  assert.equal(contexts.length, 0);
  const availability = await f.handler.handle("call", 2, "Anything Friday afternoon?");
  assert.match(availability.reply.message, /Friday/);
  assert.match(availability.reply.message, /requested 2026-11-20 afternoon/);
  const expected = f.slots.filter((slot) => slot.service === f.referral.service
    && slot.starts_at >= "2026-11-20T17:00:00.000Z" && slot.starts_at < "2026-11-20T22:00:00.000Z")[1];
  assert.ok(expected);
  const proposal = await f.handler.handle("call", 3, "The second appointment works for me");
  assert.match(proposal.reply.message, /Say yes to confirm/);
  assert.equal(booking.mock.callCount(), 0);
  assert.match((await f.handler.handle("call", 4, "Sounds great")).reply.message, /Say yes to confirm/);
  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts[1]?.preference, { date: "2026-11-20", period: "afternoon" });
  assert.equal(booking.mock.callCount(), 0);
  assert.match((await f.handler.handle("call", 5, "yes")).reply.message, /Your demo appointment is booked/);
  assert.equal(booking.mock.callCount(), 1);
  assert.equal(f.records.get(f.patient.id)?.referrals[0]?.scheduling.appointment_at, expected.starts_at);
  for (const privateField of [f.patient.id, f.patient.phone, f.patient.email, f.referral.reason]) {
    assert.ok(!JSON.stringify(contexts).includes(privateField));
  }
});

test("model choices not actually offered cannot book, and interpreter failures propagate", async (t) => {
  const f = fixture({
    async interpret() {
      return { action: "choose_slot", choice: 3 };
    },
  });
  const slot = f.slots.find((item) => item.service === f.referral.service);
  assert.ok(slot);
  f.slots.splice(0, f.slots.length, slot);
  const booking = t.mock.method(f.store, "book");
  await f.handler.handle("call", 0, "");
  await f.handler.handle("call", 1, f.patient.id);
  assert.match((await f.handler.handle("call", 2, "The third appointment please")).reply.message, /Choose one of the offered options/);
  assert.equal(booking.mock.callCount(), 0);
  const broken = fixture({ async interpret() { throw new Error("Upstream unavailable"); } });
  await broken.handler.handle("call", 0, "");
  await assert.rejects(broken.handler.handle("call", 1, "I would like to schedule"), /Upstream unavailable/);
});

test("AI full-name identification retains exact lookup and explicit referral selection", async () => {
  const f = fixture({
    async interpret(context) {
      return context.patientSelected ? { action: "referral", choice: 2 }
        : { action: "patient_name", fullName: "Anne-Marie O'Neil" };
    },
  });
  f.patient.first_name = "Anne-Marie";
  f.patient.last_name = "O'Neil";
  f.patient.referrals.push({ ...structuredClone(f.referral), referral_id: "ref_9001", source_hospital: "Demo Other Hospital" });
  await f.handler.handle("call", 0, "");
  const identified = await f.handler.handle("call", 1, "Could you look up Anne-Marie O'Neil?");
  assert.match(identified.reply.message, /^Welcome, Anne-Marie\./);
  assert.match(identified.reply.message, /Referral 2:/);
  const selected = await f.handler.handle("call", 2, "The second referral please");
  assert.match(selected.reply.message, /from Demo Other Hospital/);
  assert.match(selected.reply.message, /Option 1/);
});

test("invalid or expired date preferences clear offered choices with an explicit refresh prompt", async () => {
  let date = "2027-01-01";
  let clock = Date.parse("2026-11-18T23:50:00-05:00");
  const interpreter: ReferralInterpreter = {
    async interpret() { return { action: "availability", date, period: "evening" }; },
  };
  const f = fixture();
  const handler = new ReferralFrontdesk(f.store, () => clock, interpreter);
  await handler.handle("call", 0, "");
  await handler.handle("call", 1, f.patient.id);
  assert.match((await handler.handle("call", 2, "A later date please")).reply.message, /next 30 days/);
  assert.match((await handler.handle("call", 3, "book option one")).reply.message, /ask for availability/);
  date = "2026-11-18";
  await handler.handle("call", 4, "Tonight please");
  clock += 11 * 60_000;
  assert.match((await handler.handle("call", 5, "availability")).reply.message, /no longer in the search range/);
  assert.match((await handler.handle("call", 6, "availability")).reply.message, /Option 1/);
});

test("voice patient lookup reads the correct referral/clinic, replays turns and proposes without booking", async () => {
  const { handler, patient, referral, clinic, queries } = fixture();
  const original = structuredClone(patient);
  const greeting = await handler.handle("call", 0, "");
  assert.match(greeting.reply.message, /book a demo appointment/);
  const result = await handler.handle("call", 1, patient.id);
  assert.ok(result.reply.message.startsWith(`Welcome, ${patient.first_name}.`));
  assert.match(result.reply.message, new RegExp(clinic.name));
  assert.match(result.reply.message, /Option 1/);
  assert.match(result.reply.message, /EST/);
  assert.deepEqual(queries, [{ clinicId: clinic.id, service: referral.service, time: now }]);
  assert.deepEqual(await handler.handle("call", 1, patient.id), result);
  assert.equal(queries.length, 1);
  const booking = await handler.handle("call", 2, "book option one");
  assert.match(booking.reply.message, /Say yes to confirm or no to discard/);
  assert.deepEqual(patient, original);
});

test("voice booking requires an offered choice and explicit yes; decline and unclear answers never book", async (t) => {
  const { handler, patient, store, records } = fixture();
  const booking = t.mock.method(store, "book");
  await handler.handle("call", 0, "");
  assert.match((await handler.handle("call", 1, "book option one")).reply.message, /First identify/);
  await handler.handle("call", 2, patient.id);
  assert.match((await handler.handle("call", 3, "yes")).reply.message, /no appointment awaiting confirmation/);
  assert.match((await handler.handle("call", 4, "book option four")).reply.message, /Choose one of the offered/);
  assert.match((await handler.handle("call", 5, "book option one")).reply.message, /Say yes to confirm/);
  assert.match((await handler.handle("call", 6, "maybe")).reply.message, /Say yes to confirm/);
  assert.equal(booking.mock.callCount(), 0);
  assert.match((await handler.handle("call", 7, "no")).reply.message, /No appointment was booked/);
  assert.equal(booking.mock.callCount(), 0);
  assert.deepEqual(records.get(patient.id), patient);
});

test("simultaneous voice confirmations and webhook replays submit one booking request", async (t) => {
  const { handler, patient, store, slots, records, clinic } = fixture();
  const booking = t.mock.method(store, "book");
  t.mock.method(console, "log", () => {});
  await handler.handle("call", 0, "");
  await handler.handle("call", 1, `${patient.first_name} ${patient.last_name}`);
  const proposal = await handler.handle("call", 2, "book option two");
  assert.match(proposal.reply.message, new RegExp(clinic.name));
  assert.match(proposal.reply.message, /30 minutes/);
  const [first, duplicate] = await Promise.all([
    handler.handle("call", 3, "yes"), handler.handle("call", 3, "yes"),
  ]);
  assert.match(first.reply.message, /Your demo appointment is booked/);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(await handler.handle("call", 3, "yes"), first);
  assert.equal(booking.mock.callCount(), 1);
  assert.equal(slots.filter((slot) => slot.status === "booked").length, 1);
  assert.equal(records.get(patient.id)?.referrals[0]?.status, "scheduled");
  assert.match((await handler.handle("call", 4, patient.id)).reply.message, /no active referrals/);
});

test("a taken slot is rejected at confirmation and availability can be refreshed", async (t) => {
  const { handler, patient, slots, referral } = fixture();
  t.mock.method(console, "log", () => {});
  await handler.handle("call", 0, "");
  await handler.handle("call", 1, patient.id);
  await handler.handle("call", 2, "option one");
  const slot = slots.find((item) => item.service === referral.service);
  assert.ok(slot);
  slot.status = "booked";
  assert.match((await handler.handle("call", 3, "yes")).reply.message, /no longer available/);
  const refreshed = await handler.handle("call", 4, "availability");
  assert.match(refreshed.reply.message, /Option 1/);
  assert.equal(patient.referrals[0]?.status, "pending_contact");
});

test("patient changes clear old offered choices, and stale referrals cannot be booked", async (t) => {
  const { handler, patient, store, records } = fixture();
  const booking = t.mock.method(store, "book");
  await handler.handle("call", 0, "");
  await handler.handle("call", 1, patient.id);
  await handler.handle("call", 2, "Fictional Missingperson");
  assert.match((await handler.handle("call", 3, "book option one")).reply.message, /First identify/);
  assert.equal(booking.mock.callCount(), 0);
  await handler.handle("call", 4, patient.id);
  await handler.handle("call", 5, "book option one");
  const current = records.get(patient.id)?.referrals[0];
  assert.ok(current);
  current.status = "declined";
  assert.match((await handler.handle("call", 6, "yes")).reply.message, /no longer available for scheduling/);
});

test("uncertain confirmations retain the request and do not claim that no booking occurred", async (t) => {
  const { handler, patient, store } = fixture();
  const requests: string[] = [];
  t.mock.method(store, "book", async (request: BookingRequest) => {
    requests.push(request.bookingId);
    throw new Error("Unknown write outcome");
  });
  await handler.handle("call", 0, "");
  await handler.handle("call", 1, patient.id);
  await handler.handle("call", 2, "book option one");
  await assert.rejects(handler.handle("call", 3, "yes"), /Unknown write outcome/);
  const decline = await handler.handle("call", 3, "no");
  assert.match(decline.reply.message, /may already have booked/);
  assert.doesNotMatch(decline.reply.message, /No appointment was booked|discarded/);
  await assert.rejects(handler.handle("call", 4, "yes"), /Unknown write outcome/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
});

test("a later call resumes a previously confirmed durable booking intent", async (t) => {
  const { handler, patient, referral, clinic, slots, records } = fixture();
  t.mock.method(console, "log", () => {});
  const slot = slots.find((item) => item.service === referral.service);
  assert.ok(slot);
  referral.scheduling.booking = {
    id: "00000000-0000-4000-8000-000000000001", clinic_id: clinic.id,
    slot_id: slot.id, requested_at: asOf, state: "pending",
  };
  await handler.handle("new-call", 0, "");
  const recovered = await handler.handle("new-call", 1, patient.id);
  assert.match(recovered.reply.message, /Your demo appointment is booked/);
  assert.equal(records.get(patient.id)?.referrals[0]?.scheduling.booking?.state, "confirmed");
  assert.equal(slots.find((item) => item.id === slot.id)?.status, "booked");
});

test("full-name Cosmos lookup is parameterized, case-insensitive and limited to demo matches", async () => {
  const { patient } = fixture();
  patient.first_name = "Demo Anne-Marie";
  patient.last_name = "O'Neil";
  let storedPatient = patient;
  let queries = 0;
  const container = {
    items: {
      query(query: import("@azure/cosmos").SqlQuerySpec) {
        queries += 1;
        assert.match(query.query, /SELECT TOP 2/);
        assert.match(query.query, /c.is_demo = true AND c.demo_dataset = @dataset/);
        assert.match(query.query, /STRINGEQUALS/);
        assert.doesNotMatch(query.query, /anne|neil/i);
        assert.deepEqual(query.parameters, [
          { name: "@dataset", value: patient.demo_dataset },
          { name: "@fullName", value: "anne-marie o'neil" },
          { name: "@demoFullName", value: "demo anne-marie o'neil" },
        ]);
        return { async fetchAll() { return { resources: [storedPatient] }; } };
      },
    },
  };
  assert.deepEqual(await readPatientsByFullName(container, "  DEMO  Anne-Marie   O’Neil  "), [patient]);
  assert.equal(queries, 1);
  storedPatient = { ...patient, first_name: "Anne-Marie" };
  assert.deepEqual(await readPatientsByFullName(container, "Anne-Marie O'Neil"), [storedPatient]);
  assert.equal(queries, 2);
  await assert.rejects(readPatientsByFullName(container, "Anne-Marie"), /first and last name/);
  assert.equal(queries, 2);
  for (const invalid of [
    { ...patient, is_demo: false },
    { ...patient, last_name: "Different" },
  ]) {
    await assert.rejects(readPatientsByFullName({
      items: { query() { return { async fetchAll() { return { resources: [invalid] }; } }; } },
    }, "Anne-Marie O'Neil"));
  }
});

test("full-name voice lookup accepts natural prefixes, optional Demo marker, apostrophes and hyphens", async () => {
  const { handler, patient, clinic } = fixture();
  patient.first_name = "Demo Anne-Marie";
  patient.last_name = "O'Neil";
  const phrases = [
    "Anne-Marie O'Neil", "Demo Anne-Marie O'Neil",
    "My name is ANNE-MARIE O’NEIL.", "patient Anne-Marie O'Neil",
    "full name Anne-Marie O'Neil", "I am Anne-Marie O'Neil",
  ];
  for (const [index, speech] of phrases.entries()) {
    const callId = `name-call-${index}`;
    await handler.handle(callId, 0, "");
    const result = await handler.handle(callId, 1, speech);
    assert.match(result.reply.message, /^Welcome, Anne-Marie\./);
    assert.match(result.reply.message, new RegExp(clinic.name));
    assert.match(result.reply.message, /Option 1/);
  }
});

test("ambiguous and unmatched names clear prior patient context and permit ID fallback", async () => {
  const { handler, patient, records, queries } = fixture();
  await handler.handle("call", 0, "");
  await handler.handle("call", 1, patient.id);
  const fullName = `${patient.first_name} ${patient.last_name}`;
  records.set("patient_999", { ...structuredClone(patient), id: "patient_999", patient_id: "patient_999" });
  const ambiguous = await handler.handle("call", 2, fullName);
  assert.match(ambiguous.reply.message, /More than one demo patient matches/);
  assert.doesNotMatch(ambiguous.reply.message, /Welcome,|Option 1|Referral 1/);
  assert.equal(queries.length, 1);
  assert.match((await handler.handle("call", 3, "availability")).reply.message, /Say a demo patient number/);
  assert.match((await handler.handle("call", 4, patient.id)).reply.message, /Option 1/);
  const missing = await handler.handle("call", 5, "My name is Fictional Missingperson");
  assert.match(missing.reply.message, /not found/);
  assert.doesNotMatch(missing.reply.message, /Welcome,/);
  assert.match((await handler.handle("call", 6, "availability")).reply.message, /Say a demo patient number/);
  assert.equal(queries.length, 2);
});

test("a first name alone cannot select a patient and name lookup retains referral choice behavior", async (t) => {
  const { handler, patient, store, referral } = fixture();
  const lookup = t.mock.method(store, "patientsByFullName");
  await handler.handle("call", 0, "");
  assert.match((await handler.handle("call", 1, "Anne")).reply.message, /first and last name/);
  assert.equal(lookup.mock.callCount(), 0);
  patient.referrals.push({
    ...structuredClone(referral), referral_id: "ref_9001", source_hospital: "Demo Other Hospital",
  });
  const choices = await handler.handle("call", 2, `${patient.first_name} ${patient.last_name}`);
  assert.match(choices.reply.message, /Referral 1:/);
  assert.match(choices.reply.message, /Referral 2:/);
  assert.ok(choices.reply.message.startsWith(`Welcome, ${patient.first_name}.`));
  assert.doesNotMatch(choices.reply.message, /Option 1/);
  const availability = await handler.handle("call", 3, "referral two");
  assert.match(availability.reply.message, /from Demo Other Hospital/);
  assert.doesNotMatch(availability.reply.message, /Welcome,/);
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

test("empty, missing and inactive records do not permit booking", async () => {
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
  assert.match(await post(0, ""), /fictional referral scheduling demo/);
  const infos: string[] = [];
  t.mock.method(console, "log", (entry: string) => infos.push(entry));
  assert.match(await post(1, `My name is ${patient.first_name} ${patient.last_name}`), /Option 1/);
  assert.ok(!infos.join().includes(patient.first_name));
  assert.ok(!infos.join().includes(patient.last_name));
  assert.match(await post(2, "yes"), /no appointment awaiting confirmation/);
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  const failure = t.mock.method(store, "availability", async () => { throw new Error("Dependency unavailable"); });
  assert.match(await post(3, "availability"), /could not verify the result/);
  assert.equal(logs.length, 1);
  failure.mock.restore();
  assert.match(await post(3, "book option one"), /Say yes to confirm/);
  const booked = await post(4, "yes");
  assert.match(booked, /Your demo appointment is booked/);
  assert.equal(await post(4, "yes"), booked);
  assert.ok(infos.join().includes("cosmos.booking.finalize"));
  assert.ok(!infos.join().includes(patient.id));
  assert.ok(!infos.join().includes(patient.first_name));
  assert.ok(!infos.join().includes(patient.last_name));
});
