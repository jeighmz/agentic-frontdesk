import type { PatchOperation, RequestOptions } from "@azure/cosmos";
import { z } from "zod";
import { slotFitsClinic, slotSchema, type AppointmentSlot } from "./availability.ts";
import { StateConflict } from "./domain.ts";
import { observeOperation } from "./logging.ts";
import { clinicSchema, isSchedulableReferral, patientSchema, type Patient } from "./referral-models.ts";

const requestSchema = z.object({
  bookingId: z.uuid(),
  patientId: z.string().regex(/^patient_\d{3}$/),
  referralId: z.string().regex(/^ref_\d{4}$/),
  clinicId: z.string().regex(/^clinic_\d{3}$/),
  slotId: z.string().min(1),
});
export type BookingRequest = z.infer<typeof requestSchema>;
export type BookingResult =
  | { status: "booked"; slot: AppointmentSlot; clinicName: string }
  | { status: "slot_unavailable" | "referral_unavailable" | "referral_changed" | "booking_in_progress" | "already_scheduled" };

type ReadResult = { resource?: unknown; etag?: string; statusCode: number };
type ReadItem = { read(): Promise<ReadResult> };
type BookingItem = ReadItem & {
  patch(operations: PatchOperation[], options: RequestOptions): Promise<unknown>;
};
export type BookingDocuments = {
  patients: { item(id: string, partitionKey: string): BookingItem };
  slots: { item(id: string, partitionKey: string): BookingItem };
  clinics: { item(id: string, partitionKey: string): ReadItem };
};

function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 412;
}

function etag(response: ReadResult): string {
  if (!response.etag) throw new Error("Booking document is missing an ETag");
  return response.etag;
}

async function readPatient(item: ReadItem): Promise<{ patient: Patient; version: string } | null> {
  const response = await item.read();
  if (response.statusCode === 404) return null;
  return { patient: patientSchema.parse(response.resource), version: etag(response) };
}

function ownsSlot(slot: AppointmentSlot, request: BookingRequest): boolean {
  return slot.status === "booked" && slot.booking?.id === request.bookingId
    && slot.booking.patient_id === request.patientId && slot.booking.referral_id === request.referralId;
}

async function blockUnclaimedSlot(item: BookingItem, slot: AppointmentSlot, version: string): Promise<AppointmentSlot> {
  if (slot.status !== "available") return slot;
  try {
    // Fence any in-flight duplicate claim before releasing the referral's intent.
    await observeOperation("cosmos.booking.expire", () => item.patch([
      { op: "replace", path: "/status", value: "blocked" },
    ], { accessCondition: { type: "IfMatch", condition: version } }));
    return { ...slot, status: "blocked" };
  } catch (error) {
    if (!isConflict(error)) throw error;
    const current = slotSchema.parse((await item.read()).resource);
    if (current.status === "available") throw new StateConflict("Unclaimed slot changed while closing the booking");
    return current;
  }
}

async function releaseIntent(item: BookingItem, request: BookingRequest): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readPatient(item);
    const index = current?.patient.referrals.findIndex((referral) => referral.referral_id === request.referralId);
    if (!current || index === undefined || index < 0) throw new StateConflict("Cannot locate the booking intent to release");
    const booking = current.patient.referrals[index]?.scheduling.booking;
    if (!booking) return;
    if (booking.id !== request.bookingId || booking.state !== "pending") {
      throw new StateConflict("Booking intent changed while releasing the unavailable slot");
    }
    try {
      await observeOperation("cosmos.booking.release", () => item.patch([
        { op: "remove", path: `/referrals/${index}/scheduling/booking` },
      ], { accessCondition: { type: "IfMatch", condition: current.version } }));
      return;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  throw new StateConflict("Booking intent release conflicted repeatedly");
}

async function finalizeBooking(item: BookingItem, request: BookingRequest, slot: AppointmentSlot): Promise<void> {
  if (!slot.booking || !ownsSlot(slot, request)) throw new Error("Cannot finalize a slot without matching ownership");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readPatient(item);
    const index = current?.patient.referrals.findIndex((referral) => referral.referral_id === request.referralId);
    if (!current || index === undefined || index < 0) throw new StateConflict("Booked referral no longer exists");
    const referral = current.patient.referrals[index];
    const intent = referral?.scheduling.booking;
    if (!referral || !intent || intent.id !== request.bookingId || intent.slot_id !== slot.id
      || intent.clinic_id !== request.clinicId || referral.destination_clinic_id !== request.clinicId
      || referral.service !== slot.service) {
      throw new StateConflict("Booked referral changed and needs staff review");
    }
    if (intent.state === "confirmed") {
      if (referral.status !== "scheduled" || referral.scheduling.status !== "scheduled"
        || referral.scheduling.appointment_at !== slot.starts_at) {
        throw new StateConflict("Confirmed booking is inconsistent with its referral");
      }
      return;
    }
    if (!isSchedulableReferral(referral)) throw new StateConflict("Booked referral is no longer schedulable");
    const prefix = `/referrals/${index}`;
    const lastContact = Math.max(
      Date.parse(referral.scheduling.last_contact_at ?? referral.received_at),
      Date.parse(slot.booking.booked_at),
    );
    try {
      await observeOperation("cosmos.booking.finalize", () => item.patch([
        { op: "replace", path: `${prefix}/status`, value: "scheduled" },
        { op: "replace", path: `${prefix}/scheduling/status`, value: "scheduled" },
        { op: "replace", path: `${prefix}/scheduling/appointment_at`, value: slot.starts_at },
        { op: "replace", path: `${prefix}/scheduling/next_contact_at`, value: null },
        { op: "replace", path: `${prefix}/scheduling/last_contact_at`, value: new Date(lastContact).toISOString() },
        { op: "replace", path: `${prefix}/scheduling/contact_attempts`, value: Math.max(1, referral.scheduling.contact_attempts) },
        { op: "replace", path: `${prefix}/scheduling/booking/state`, value: "confirmed" },
      ], { accessCondition: { type: "IfMatch", condition: current.version } }));
      return;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  throw new StateConflict("Booking finalization conflicted repeatedly");
}

export async function bookReferral(
  documents: BookingDocuments, input: BookingRequest, now: () => number = Date.now,
): Promise<BookingResult> {
  const request = requestSchema.parse(input);
  const patientItem = documents.patients.item(request.patientId, request.patientId);
  const slotItem = documents.slots.item(request.slotId, request.clinicId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readPatient(patientItem);
    if (!current) throw new StateConflict("Booking patient is missing; the outcome needs staff review");
    const index = current.patient.referrals.findIndex((referral) => referral.referral_id === request.referralId);
    const referral = current.patient.referrals[index];
    if (!referral) throw new StateConflict("Booking referral is missing; the outcome needs staff review");
    const intent = referral.scheduling.booking;
    if (intent && intent.id !== request.bookingId) {
      return { status: intent.state === "confirmed" ? "already_scheduled" : "booking_in_progress" };
    }
    if (intent && (intent.slot_id !== request.slotId || intent.clinic_id !== request.clinicId)) {
      throw new StateConflict("Booking retry does not match the saved intent");
    }
    if (referral.destination_clinic_id !== request.clinicId) {
      if (intent) throw new StateConflict("Saved booking referral changed and needs staff review");
      return { status: "referral_changed" };
    }
    if (!intent && !isSchedulableReferral(referral)) {
      return { status: referral.status === "scheduled" ? "already_scheduled" : "referral_unavailable" };
    }
    const clinicResponse = await documents.clinics.item(request.clinicId, request.clinicId).read();
    const clinic = clinicSchema.parse(clinicResponse.resource);
    if (!clinic.services.includes(referral.service)) throw new Error("Referral service is not supported by its clinic");
    let response = await slotItem.read();
    if (response.statusCode === 404) {
      if (intent?.state === "confirmed") throw new StateConflict("Confirmed booking slot is missing");
      if (intent) await releaseIntent(patientItem, request);
      return { status: "slot_unavailable" };
    }
    let slot = slotSchema.parse(response.resource);
    if (slot.id !== request.slotId || slot.clinic_id !== request.clinicId || slot.service !== referral.service) {
      throw new Error("Booking slot does not match the referral");
    }
    if (intent?.state === "confirmed") {
      await finalizeBooking(patientItem, request, slot);
      return { status: "booked", slot, clinicName: clinic.name };
    }
    if (!isSchedulableReferral(referral)) throw new StateConflict("Pending referral is no longer schedulable");
    if (Date.parse(referral.received_at) > now()
      || Date.parse(referral.scheduling.last_contact_at ?? referral.received_at) > now()) {
      throw new Error("Referral contact dates are in the future");
    }
    if (!ownsSlot(slot, request) && (slot.status !== "available" || Date.parse(slot.starts_at) <= now()
      || !slotFitsClinic(slot, clinic))) {
      if (!intent) return { status: "slot_unavailable" };
      slot = await blockUnclaimedSlot(slotItem, slot, etag(response));
      if (!ownsSlot(slot, request)) {
        await releaseIntent(patientItem, request);
        return { status: "slot_unavailable" };
      }
    }
    if (!intent) {
      try {
        await observeOperation("cosmos.booking.intent", () => patientItem.patch([
          {
            op: "add", path: `/referrals/${index}/scheduling/booking`,
            value: {
              id: request.bookingId, slot_id: request.slotId, clinic_id: request.clinicId,
              requested_at: new Date(now()).toISOString(), state: "pending",
            },
          },
        ], { accessCondition: { type: "IfMatch", condition: current.version } }));
      } catch (error) {
        if (isConflict(error)) continue;
        throw error;
      }
    }
    if (!ownsSlot(slot, request)) {
      // Recheck the clock after saving intent; expired choices cannot become new bookings.
      if (Date.parse(slot.starts_at) <= now()) {
        slot = await blockUnclaimedSlot(slotItem, slot, etag(response));
        if (!ownsSlot(slot, request)) {
          await releaseIntent(patientItem, request);
          return { status: "slot_unavailable" };
        }
      }
      if (!ownsSlot(slot, request)) {
        const booking = {
          id: request.bookingId, patient_id: request.patientId, referral_id: request.referralId,
          booked_at: new Date(now()).toISOString(),
        };
        try {
          await observeOperation("cosmos.booking.slot", () => slotItem.patch([
            { op: "replace", path: "/status", value: "booked" },
            { op: "add", path: "/booking", value: booking },
          ], { accessCondition: { type: "IfMatch", condition: etag(response) } }));
          slot = { ...slot, status: "booked", booking };
        } catch (error) {
          if (!isConflict(error)) throw error;
          response = await slotItem.read();
          slot = slotSchema.parse(response.resource);
          if (slot.status === "available") continue;
        }
      }
    }
    if (!ownsSlot(slot, request)) {
      await releaseIntent(patientItem, request);
      return { status: "slot_unavailable" };
    }
    await finalizeBooking(patientItem, request, slot);
    return { status: "booked", slot, clinicName: clinic.name };
  }
  throw new StateConflict("Booking intent conflicted repeatedly");
}
