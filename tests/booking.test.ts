import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, mock, test } from "node:test";
import { generateAvailability } from "../src/availability.ts";
import { bookReferral, type BookingRequest } from "../src/booking.ts";
import { generateClinics, generatePatients } from "../src/scripts/demo-data.ts";
import { memoryBookingDocuments } from "./test-support/booking-documents.ts";

const asOf = "2026-11-18T23:00:00.000Z";
const now = Date.parse(asOf);
beforeEach(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});
afterEach(() => mock.restoreAll());

function fixture() {
  const clinics = generateClinics();
  const patient = generatePatients(clinics, 42, asOf).find((item) =>
    item.referrals.length === 1 && item.referrals[0]?.status === "pending_contact");
  assert.ok(patient);
  const referral = patient.referrals[0];
  assert.ok(referral);
  const clinic = clinics.find((item) => item.id === referral.destination_clinic_id);
  assert.ok(clinic);
  const slots = generateAvailability([clinic], asOf).filter((slot) => slot.service === referral.service);
  const slot = slots[0];
  assert.ok(slot);
  const other = { ...structuredClone(patient), id: "patient_999", patient_id: "patient_999" };
  const memory = memoryBookingDocuments(clinics, [patient, other], slots);
  const request: BookingRequest = {
    bookingId: randomUUID(), patientId: patient.id, referralId: referral.referral_id,
    clinicId: clinic.id, slotId: slot.id,
  };
  return { ...memory, patient, other, referral, clinic, slots, slot, request };
}

test("confirmed booking claims a slot and marks only its referral scheduled; replay is idempotent", async () => {
  const f = fixture();
  const result = await bookReferral(f.documents, f.request, () => now);
  assert.equal(result.status, "booked");
  const stored = f.storedPatient(f.request.patientId);
  const referral = stored.referrals[0];
  assert.ok(referral);
  assert.equal(referral.status, "scheduled");
  assert.equal(referral.scheduling.status, "scheduled");
  assert.equal(referral.scheduling.appointment_at, f.slot.starts_at);
  assert.equal(referral.scheduling.booking?.state, "confirmed");
  assert.equal(referral.scheduling.next_contact_at, null);
  assert.equal(referral.scheduling.contact_attempts, 1);
  assert.equal(f.storedSlot(f.request.slotId, f.request.clinicId).booking?.id, f.request.bookingId);
  assert.deepEqual(stored, {
    ...f.patient,
    referrals: [{
      ...f.referral, status: "scheduled",
      scheduling: {
        ...f.referral.scheduling,
        status: "scheduled", appointment_at: f.slot.starts_at, next_contact_at: null,
        last_contact_at: asOf, contact_attempts: 1,
        booking: {
          id: f.request.bookingId, slot_id: f.request.slotId, clinic_id: f.request.clinicId,
          requested_at: asOf, state: "confirmed",
        },
      },
    }],
  });
  assert.equal(f.writes.length, 3);
  assert.equal((await bookReferral(f.documents, f.request, () => now)).status, "booked");
  assert.equal(f.writes.length, 3);
});

test("two patients racing for one slot cannot both book it", async () => {
  const f = fixture();
  const otherRequest = { ...f.request, patientId: f.other.id, bookingId: randomUUID() };
  const results = await Promise.all([
    bookReferral(f.documents, f.request, () => now),
    bookReferral(f.documents, otherRequest, () => now),
  ]);
  assert.equal(results.filter((result) => result.status === "booked").length, 1);
  assert.equal(results.filter((result) => result.status === "slot_unavailable").length, 1);
  const patients = [f.storedPatient(f.request.patientId), f.storedPatient(f.other.id)];
  assert.equal(patients.filter((patient) => patient.referrals[0]?.status === "scheduled").length, 1);
  const loser = patients.find((patient) => patient.referrals[0]?.status !== "scheduled");
  assert.ok(loser);
  assert.equal(loser.referrals[0]?.scheduling.booking, undefined);
});

test("one referral cannot be booked into two different slots by concurrent calls", async () => {
  const f = fixture();
  const otherSlot = f.slots[1];
  assert.ok(otherSlot);
  const results = await Promise.all([
    bookReferral(f.documents, f.request, () => now),
    bookReferral(f.documents, { ...f.request, bookingId: randomUUID(), slotId: otherSlot.id }, () => now),
  ]);
  assert.equal(results.filter((result) => result.status === "booked").length, 1);
  assert.equal([f.storedSlot(f.request.slotId, f.request.clinicId), f.storedSlot(otherSlot.id, f.request.clinicId)]
    .filter((slot) => slot.status === "booked").length, 1);
});

test("duplicate concurrent requests with the same booking ID converge to one booking", async () => {
  const f = fixture();
  const results = await Promise.all([
    bookReferral(f.documents, f.request, () => now),
    bookReferral(f.documents, f.request, () => now),
  ]);
  assert.ok(results.every((result) => result.status === "booked"));
  assert.equal(f.writes.filter((write) => write.container === "slots").length, 1);
  assert.equal(f.writes.filter((write) => write.operations.some((operation) => operation.path.endsWith("/booking/state"))).length, 1);
});

test("interrupted intent, slot, and finalization writes recover without reopening or double booking", async () => {
  for (const stage of ["intent", "slot", "finalize"] as const) {
    for (const phase of ["before", "after"] as const) {
      const f = fixture();
      let failed = false;
      f.setHook((event) => {
        const matches = stage === "intent"
          ? event.container === "patients" && event.operations.some((operation) => operation.path.endsWith("/booking"))
          : stage === "slot" ? event.container === "slots"
            : event.operations.some((operation) => operation.path.endsWith("/booking/state"));
        if (!failed && matches && event.phase === phase) {
          failed = true;
          throw new Error("Simulated interrupted request");
        }
      });
      await assert.rejects(bookReferral(f.documents, f.request, () => now), /Simulated interrupted/);
      f.setHook(undefined);
      assert.equal((await bookReferral(f.documents, f.request, () => now)).status, "booked", `${stage}/${phase}`);
      assert.equal(f.storedSlot(f.request.slotId, f.request.clinicId).booking?.id, f.request.bookingId);
      assert.equal(f.storedPatient(f.request.patientId).referrals[0]?.scheduling.booking?.state, "confirmed");
      assert.equal(f.writes.filter((write) => write.container === "slots").length, 1);
    }
  }
});

test("expired choices, wrong clinics, and already scheduled referrals do not create bookings", async () => {
  const expired = fixture();
  assert.equal((await bookReferral(expired.documents, expired.request, () => Date.parse(expired.slot.starts_at))).status,
    "slot_unavailable");
  assert.equal(expired.writes.length, 0);
  const changed = fixture();
  assert.equal((await bookReferral(changed.documents, { ...changed.request, clinicId: "clinic_999" }, () => now)).status,
    "referral_changed");
  assert.equal(changed.writes.length, 0);
  const booked = fixture();
  await bookReferral(booked.documents, booked.request, () => now);
  assert.equal((await bookReferral(booked.documents, { ...booked.request, bookingId: randomUUID() }, () => now)).status,
    "already_scheduled");
  assert.equal(booked.writes.length, 3);
});

test("wrong services, closed clinic hours and previously booked slots are rejected before writes", async () => {
  const f = fixture();
  const wrongService = memoryBookingDocuments([f.clinic], [f.patient], [{
    ...f.slot, service: f.slot.service === "physical_therapy" ? "sports_rehab" : "physical_therapy",
  }]);
  await assert.rejects(bookReferral(wrongService.documents, f.request, () => now), /does not match the referral/);
  assert.equal(wrongService.writes.length, 0);
  const closed = memoryBookingDocuments([{ ...f.clinic, hours: {} }], [f.patient], [f.slot]);
  assert.equal((await bookReferral(closed.documents, f.request, () => now)).status, "slot_unavailable");
  assert.equal(closed.writes.length, 0);
  const booked = memoryBookingDocuments([f.clinic], [f.patient], [{ ...f.slot, status: "booked" }]);
  assert.equal((await bookReferral(booked.documents, f.request, () => now)).status, "slot_unavailable");
  assert.equal(booked.writes.length, 0);
});

test("expired intent cleanup fences an in-flight duplicate claim before unlocking the referral", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let paused = false;
  f.setHook(async (event) => {
    if (!paused && event.phase === "before" && event.container === "slots"
      && event.operations.some((operation) => operation.path === "/booking")) {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
  });
  const delayed = bookReferral(f.documents, f.request, () => now);
  await entered.promise;
  try {
    assert.equal((await bookReferral(f.documents, f.request, () => Date.parse(f.slot.starts_at))).status,
      "slot_unavailable");
  } finally {
    resume.resolve();
  }
  assert.equal((await delayed).status, "slot_unavailable");
  assert.equal(f.storedSlot(f.slot.id, f.clinic.id).status, "blocked");
  assert.equal(f.storedPatient(f.patient.id).referrals[0]?.scheduling.booking, undefined);
  assert.equal(f.writes.filter((write) => write.operations.some((operation) => operation.path === "/booking")).length, 0);
});

test("finalization retries ETag conflicts without losing other referrals or unmodeled patient fields", async () => {
  const f = fixture();
  const patient = {
    ...f.patient, staff_note: "Synthetic scheduling note",
    referrals: [f.referral, { ...structuredClone(f.referral), referral_id: "ref_9001" }],
  };
  const memory = memoryBookingDocuments([f.clinic], [patient], f.slots);
  let reordered = false;
  memory.setHook(async (event) => {
    if (!reordered && event.phase === "before"
      && event.operations.some((operation) => operation.path.endsWith("/booking/state"))) {
      reordered = true;
      const current = memory.storedPatient(patient.id);
      const [first, second] = current.referrals;
      assert.ok(first && second);
      const item = memory.documents.patients.item(patient.id, patient.id);
      const { etag } = await item.read();
      assert.ok(etag);
      await item.patch([{ op: "replace", path: "/referrals", value: [second, first] }],
        { accessCondition: { type: "IfMatch", condition: etag } });
    }
  });
  assert.equal((await bookReferral(memory.documents, f.request, () => now)).status, "booked");
  const stored = memory.storedPatient(patient.id);
  assert.equal(stored.referrals[0]?.referral_id, "ref_9001");
  assert.equal(stored.referrals[0]?.status, "pending_contact");
  assert.equal(stored.referrals[0]?.scheduling.booking, undefined);
  assert.equal(stored.referrals[1]?.referral_id, f.referral.referral_id);
  assert.equal(stored.referrals[1]?.status, "scheduled");
  const { resource } = await memory.documents.patients.item(patient.id, patient.id).read();
  assert.ok(typeof resource === "object" && resource !== null && "staff_note" in resource);
  assert.equal(resource.staff_note, patient.staff_note);
});

test("referral changes after a slot claim remain uncertain instead of reporting that nothing was booked", async () => {
  const f = fixture();
  f.setHook(async (event) => {
    if (event.container === "slots" && event.phase === "after") {
      const item = f.documents.patients.item(f.patient.id, f.patient.id);
      const { etag } = await item.read();
      assert.ok(etag);
      await item.patch([{ op: "replace", path: "/referrals/0/destination_clinic_id", value: "clinic_999" }],
        { accessCondition: { type: "IfMatch", condition: etag } });
    }
  });
  await assert.rejects(bookReferral(f.documents, f.request, () => now), /needs staff review/);
  f.setHook(undefined);
  await assert.rejects(bookReferral(f.documents, f.request, () => now), /needs staff review/);
  assert.equal(f.storedSlot(f.slot.id, f.clinic.id).booking?.id, f.request.bookingId);
  assert.equal(f.storedPatient(f.patient.id).referrals[0]?.scheduling.booking?.state, "pending");
});
