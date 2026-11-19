import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { availabilityWindows, type AppointmentSlot, type AvailabilityPreference, type AvailabilityWindow } from "./availability.ts";
import type { BookingRequest, BookingResult } from "./booking.ts";
import type { Reply, VoiceHandler } from "./domain.ts";
import { CLINIC_TIME_ZONE, isSchedulableReferral, normalizePatientFullName, type Patient, type Referral } from "./referral-models.ts";
import { referralIntentSchema, type ReferralInterpreter } from "./referral-interpreter.ts";
import type { ReferralStore } from "./referral-store.ts";

type PendingBooking = { request: BookingRequest; slot: AppointmentSlot; clinicName: string; submitted: boolean };
type Session = {
  turn: number;
  patientId: string | null;
  referralIds: string[];
  selectedReferralId: string | null;
  offered: { referralId: string; clinicName: string; slots: AppointmentSlot[] } | null;
  pending: PendingBooking | null;
  preference: AvailabilityPreference;
  reply: Reply;
  updatedAt: number;
};

function say(message: string, transfer = false, end = false): Reply {
  return { message, transfer, end };
}

const smallNumbers = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function numberWords(number: number): string {
  if (number === 100) return "one hundred";
  if (number < 20) return smallNumbers[number] ?? "";
  return `${tens[Math.floor(number / 10)]}${number % 10 ? ` ${smallNumbers[number % 10]}` : ""}`;
}

function selection(speech: string, prefix: string, max: number): number | null {
  const normalized = speech.toLowerCase().replace(/[_-]/g, " ").replace(/[.!?]/g, "").trim().replace(/\s+/g, " ");
  if (!normalized.startsWith(`${prefix} `)) return null;
  const value = normalized.slice(prefix.length + 1);
  for (let number = 1; number <= max; number += 1) {
    const digits = String(number).padStart(3, "0");
    const digitWords = [...digits].map((digit) => smallNumbers[Number(digit)]).join(" ");
    if ([String(number), digits, numberWords(number), digitWords].includes(value)) return number;
  }
  return null;
}

function fullNameFromSpeech(speech: string): string | null {
  if (/^(availability|available|appointments?|repeat)\b|^referral\b/i.test(speech)) return null;
  const name = speech.replace(/[.!?]+$/, "").trim()
    .replace(/^(?:my name is|i am|i'm|full name(?: is)?|name(?: is)?|patient)\s+/i, "");
  return normalizePatientFullName(name);
}

export class ReferralFrontdesk implements VoiceHandler {
  private store: ReferralStore;
  private now: () => number;
  private calls = new Map<string, Session>();
  private locks = new Map<string, Promise<void>>();
  private interpreter: ReferralInterpreter | undefined;

  constructor(store: ReferralStore, now: () => number = Date.now, interpreter?: ReferralInterpreter) {
    this.store = store;
    this.now = now;
    this.interpreter = interpreter;
  }

  async handle(callId: string, turn: number, speech: string) {
    const previous = this.locks.get(callId);
    const barrier = Promise.withResolvers<void>();
    this.locks.set(callId, barrier.promise);
    try {
      if (previous) await previous;
      return await this.handleTurn(callId, turn, speech);
    } finally {
      barrier.resolve();
      if (this.locks.get(callId) === barrier.promise) this.locks.delete(callId);
    }
  }

  private async handleTurn(callId: string, turn: number, speech: string) {
    const now = this.now();
    for (const [id, session] of this.calls) {
      if (now - session.updatedAt > 30 * 60_000) this.calls.delete(id);
    }
    const session = this.calls.get(callId);
    if (!session) {
      if (turn !== 0) return { reply: say("This demo session expired. Please call again.", false, true), turn };
      if (this.calls.size >= 100) return { reply: say("The demo is at capacity. Please call again later.", false, true), turn };
      const created: Session = {
        turn: 1, patientId: null, referralIds: [], selectedReferralId: null,
        offered: null, pending: null, preference: { date: null, period: null }, updatedAt: now,
        reply: say([
          "This is a fictional referral scheduling demo. Do not share personal or medical information.",
          "You can book a demo appointment after choosing a time and confirming. These are not real appointments.",
          "For emergencies, hang up and call your local emergency number.",
          "Say a fictional patient's first and last name, a demo patient number such as patient one, or staff. Never give a real person's name.",
        ].join(" ")),
      };
      this.calls.set(callId, created);
      return { reply: created.reply, turn: created.turn };
    }
    if (turn < session.turn || session.reply.end || session.reply.transfer) {
      return { reply: session.reply, turn: session.turn };
    }
    if (turn !== session.turn) throw new Error("Unexpected referral voice turn");
    const next = structuredClone(session);
    try {
      next.reply = turn >= 20
        ? say("The demo conversation limit has been reached. I will try to connect you to staff.", true)
        : await this.respond(next, speech.trim(), now);
    } catch (error) {
      // Retain the same request after an uncertain write; "no" must not imply it was undone.
      if (next.pending?.submitted) this.calls.set(callId, next);
      throw error;
    }
    const latest = this.calls.get(callId);
    if (latest && latest !== session) return { reply: latest.reply, turn: latest.turn };
    next.turn += 1;
    next.updatedAt = now;
    this.calls.set(callId, next);
    return { reply: next.reply, turn: next.turn };
  }

  private async respond(session: Session, speech: string, now: number): Promise<Reply> {
    if (/\b(staff|human|operator|emergency)\b/i.test(speech)) {
      session.pending = null;
      session.offered = null;
      return say("I will try to connect you to staff. For an emergency, call your local emergency number.", true);
    }
    if (session.pending) {
      if (/^(yes|yes please|confirm|book it)[.!?]*$/i.test(speech)) {
        session.pending.submitted = true;
        return this.bookingReply(session, await this.store.book(session.pending.request));
      }
      if (session.pending.submitted) {
        return say("Your earlier confirmation may already have booked the slot. I cannot discard it until its result is verified. Say yes to check the same booking, or staff.");
      }
      if (/^(no|no thanks|cancel|never mind)[.!?]*$/i.test(speech)) {
        session.pending = null;
        return say("The proposed booking was discarded. No appointment was booked. Say availability to refresh or choose another offered option.");
      }
      return say(this.confirmation(session.pending));
    }
    if (/^(yes|yes please|confirm)[.!?]*$/i.test(speech)) {
      return say("There is no appointment awaiting confirmation. Choose an offered option first, for example book option one.");
    }
    if (/\b(reschedule|cancel)\b/i.test(speech)) {
      return say("Rescheduling and appointment cancellation are not enabled yet. No appointment was changed. Say availability or staff.");
    }
    const directCommand = !speech || selection(speech, "patient", 100) !== null
      || selection(speech, "referral", 3) !== null || selection(speech, "option", 3) !== null
      || selection(speech, "slot", 3) !== null || selection(speech, "book", 3) !== null
      || selection(speech.replace(/^(book|reserve)\s+/i, ""), "option", 3) !== null
      || /^(availability|available|appointments?|repeat)[.!?]*$/i.test(speech);
    if (this.interpreter && !directCommand) {
      const intent = referralIntentSchema.parse(await this.interpreter.interpret({
        speech,
        localDate: Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(CLINIC_TIME_ZONE).toPlainDate().toString(),
        timeZone: CLINIC_TIME_ZONE,
        patientSelected: session.patientId !== null,
        referralSelected: session.selectedReferralId !== null,
        referralCount: session.referralIds.length,
        preference: { ...session.preference },
        slots: session.offered?.slots.map((slot, index) => ({ option: index + 1, localTime: this.describeSlot(slot) })) ?? [],
      }));
      switch (intent.action) {
        case "patient_number":
          speech = `patient ${intent.patientNumber}`;
          break;
        case "patient_name": {
          const fullName = intent.fullName ? normalizePatientFullName(intent.fullName) : null;
          if (!fullName) return say("Please say the fictional patient's complete first and last name, or a demo patient number.");
          speech = `my name is ${fullName}`;
          break;
        }
        case "referral":
          speech = `referral ${intent.choice}`;
          break;
        case "choose_slot":
          speech = `book option ${intent.choice}`;
          break;
        case "availability":
          session.offered = null;
          try {
            availabilityWindows(intent, now);
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            return say("I can search dates from today through the next 30 days. Please choose a date in that range.");
          }
          session.preference = { date: intent.date, period: intent.period };
          speech = "availability";
          break;
        case "handoff":
          session.offered = null;
          return say("I will try to connect you to staff. For an emergency, call your local emergency number.", true);
        case "unsupported":
          return say("Rescheduling and appointment cancellation are not enabled yet. Say availability or staff.");
        case "clarify":
          return say("I can look up a fictional patient, search by date and morning or afternoon, or propose an offered appointment. Please give one request at a time, or say staff.");
      }
    }
    if (/^(book|reserve|option|slot)\b/i.test(speech)) {
      const optionSpeech = speech.replace(/^(book|reserve)\s+/i, "");
      const option = selection(optionSpeech, "option", 3)
        ?? selection(optionSpeech, "slot", 3) ?? selection(speech, "book", 3);
      if (!session.patientId || !session.selectedReferralId || !session.offered) {
        return say("First identify a demo patient, choose an active referral, and ask for availability before booking.");
      }
      const slot = option === null ? undefined : session.offered.slots[option - 1];
      if (!slot || session.offered.referralId !== session.selectedReferralId) {
        return say("Choose one of the offered options, for example book option one, or say availability to refresh.");
      }
      session.pending = {
        request: {
          bookingId: randomUUID(), patientId: session.patientId, referralId: session.selectedReferralId,
          clinicId: slot.clinic_id, slotId: slot.id,
        },
        slot, clinicName: session.offered.clinicName, submitted: false,
      };
      return say(this.confirmation(session.pending));
    }
    const patientNumber = selection(speech, "patient", 100);
    const fullName = patientNumber === null ? fullNameFromSpeech(speech) : null;
    if (patientNumber !== null || fullName !== null) {
      session.patientId = null;
      session.referralIds = [];
      session.selectedReferralId = null;
      session.offered = null;
      session.pending = null;
      session.preference = { date: null, period: null };
      let patient: Patient | null;
      if (patientNumber !== null) {
        patient = await this.store.patient(`patient_${String(patientNumber).padStart(3, "0")}`);
      } else {
        if (!fullName) throw new Error("Full-name lookup is missing its name");
        const matches = await this.store.patientsByFullName(fullName);
        if (matches.length > 1) {
          return say("More than one demo patient matches that full name. Say the demo patient number, for example patient one, or staff. No patient was selected.");
        }
        patient = matches[0] ?? null;
      }
      if (!patient) return say("That demo patient was not found. Say their fictional first and last name again, a demo patient number, or staff.");
      const response = await this.selectPatient(session, patient, now);
      const firstName = patient.first_name.trim().replace(/^Demo\s+(?=\S)/i, "");
      return { ...response, message: `Welcome, ${firstName}. ${response.message}` };
    }
    if (!session.patientId) return say("Say a demo patient number, for example patient one, or the fictional patient's first and last name. Do not give real personal information.");
    const referralNumber = selection(speech, "referral", 3);
    if (referralNumber !== null) {
      const id = session.referralIds[referralNumber - 1];
      if (!id) return say("That referral choice was not offered. Say one of the offered referral numbers or another patient number.");
      session.selectedReferralId = id;
      session.offered = null;
      session.preference = { date: null, period: null };
    } else if (!/^(availability|available|appointments?|repeat)[.!?]*$/i.test(speech)) {
      return say("Say availability, an offered referral number such as referral one, another patient number, or staff.");
    }
    if (!session.selectedReferralId) return say("Choose an offered referral first, for example referral one.");
    const patient = await this.store.patient(session.patientId);
    const referral = patient?.referrals.find((item) => item.referral_id === session.selectedReferralId && isSchedulableReferral(item));
    if (!referral) {
      session.selectedReferralId = null;
      session.referralIds = [];
      session.offered = null;
      return say("That referral is no longer active or available. Say the patient number again to refresh the referral list.");
    }
    return this.describeReferral(session, referral, now);
  }

  private async selectPatient(session: Session, patient: Patient, now: number): Promise<Reply> {
    session.patientId = patient.id;
    const referrals = patient.referrals.filter(isSchedulableReferral);
    session.referralIds = referrals.map((referral) => referral.referral_id);
    if (!referrals.length) return say("This demo patient has no active referrals awaiting scheduling. Say another patient number or fictional full name, or staff.");
    if (referrals.length === 1 && referrals[0]) {
      session.selectedReferralId = referrals[0].referral_id;
      return this.describeReferral(session, referrals[0], now);
    }
    const choices = await Promise.all(referrals.map(async (referral, index) => {
      const clinic = await this.store.clinic(referral.destination_clinic_id);
      return `Referral ${index + 1}: ${referral.service.replaceAll("_", " ")} at ${clinic.name}, from ${referral.source_hospital}.`;
    }));
    return say(`${choices.join(" ")} Say referral one, referral two, or referral three as applicable.`);
  }

  private async describeReferral(session: Session, referral: Referral, now: number): Promise<Reply> {
    const intent = referral.scheduling.booking;
    if (intent?.state === "pending") {
      if (!session.patientId) throw new Error("Cannot resume a booking without a selected patient");
      return this.bookingReply(session, await this.store.book({
        bookingId: intent.id, patientId: session.patientId, referralId: referral.referral_id,
        clinicId: intent.clinic_id, slotId: intent.slot_id,
      }));
    }
    const clinic = await this.store.clinic(referral.destination_clinic_id);
    if (!clinic.services.includes(referral.service)) throw new Error("Referral service is not supported by its clinic");
    let windows: AvailabilityWindow[];
    try {
      windows = availabilityWindows(session.preference, now);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      session.offered = null;
      session.preference = { date: null, period: null };
      return say("The requested date is no longer in the search range. Say availability to start a new search, or give a date within the next 30 days.");
    }
    const slots = await this.store.availability(clinic.id, referral.service, now, windows);
    session.offered = { referralId: referral.referral_id, clinicName: clinic.name, slots };
    const preference = [session.preference.date, session.preference.period].filter(Boolean).join(" ");
    const context = `For ${referral.service.replaceAll("_", " ")} at ${clinic.name}, from ${referral.source_hospital}${preference ? `, requested ${preference}` : ""}:`;
    if (!slots.length) return say(`${context} no future demo slots are listed. Ask staff for help, or say another patient number.`);
    const descriptions = slots.map((slot, index) => {
      return `Option ${index + 1}: ${this.describeSlot(slot)}, 30 minutes.`;
    });
    return say(`${context} ${descriptions.join(" ")} To book, say book option one, two, or three as offered. I will ask you to confirm before reserving it. Or say availability to refresh, another patient number, or staff.`);
  }

  private describeSlot(slot: AppointmentSlot): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: slot.time_zone, weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(slot.starts_at));
  }

  private confirmation(pending: PendingBooking): string {
    return `Shall I book ${pending.slot.service.replaceAll("_", " ")} at ${pending.clinicName} on ${this.describeSlot(pending.slot)}, for 30 minutes? Say yes to confirm or no to discard this demo booking.`;
  }

  private bookingReply(session: Session, result: BookingResult): Reply {
    session.pending = null;
    session.offered = null;
    if (result.status === "booked") {
      session.selectedReferralId = null;
      session.referralIds = [];
      return say(`Your demo appointment is booked at ${result.clinicName} on ${this.describeSlot(result.slot)}, for 30 minutes. This is not a real appointment. Say your patient number or fictional full name again to check other referrals, or staff.`);
    }
    if (result.status === "slot_unavailable") {
      return say("That slot is no longer available. No appointment was booked. Say availability to choose another time.");
    }
    session.selectedReferralId = null;
    session.referralIds = [];
    if (result.status === "booking_in_progress") {
      return say("An earlier booking for this referral is still being checked. No additional booking was made. Say the patient number again to check it, or staff.");
    }
    if (result.status === "already_scheduled") {
      return say("This referral already has an appointment. No additional booking was made. Say another patient number or staff.");
    }
    return say("That referral changed or is no longer available for scheduling. No appointment was booked. Say the patient number again to refresh, or staff.");
  }
}
