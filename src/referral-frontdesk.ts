import type { Reply, VoiceHandler } from "./domain.ts";
import { normalizePatientFullName, type Patient, type Referral } from "./referral-models.ts";
import type { ReferralStore } from "./referral-store.ts";

type Session = {
  turn: number;
  patientId: string | null;
  referralIds: string[];
  selectedReferralId: string | null;
  reply: Reply;
  updatedAt: number;
};

function say(message: string, transfer = false, end = false): Reply {
  return { message, transfer, end };
}

function active(referral: Referral): boolean {
  return ["pending_contact", "contacted", "scheduling", "unable_to_reach"].includes(referral.status);
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

  constructor(store: ReferralStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  async handle(callId: string, turn: number, speech: string) {
    const now = this.now();
    for (const [id, session] of this.calls) {
      if (now - session.updatedAt > 30 * 60_000) this.calls.delete(id);
    }
    const session = this.calls.get(callId);
    if (!session) {
      if (turn !== 0) return { reply: say("This demo session expired. Please call again.", false, true), turn };
      if (this.calls.size >= 100) return { reply: say("The demo is at capacity. Please call again later.", false, true), turn };
      const created: Session = {
        turn: 1, patientId: null, referralIds: [], selectedReferralId: null, updatedAt: now,
        reply: say([
          "This is a fictional referral availability demo. Do not share personal or medical information.",
          "You can hear available demo appointments, but booking is not enabled. Nothing will be reserved.",
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
    next.reply = turn >= 20
      ? say("The demo conversation limit has been reached. I will try to connect you to staff.", true)
      : await this.respond(next, speech.trim(), now);
    const latest = this.calls.get(callId);
    if (latest && latest !== session) return { reply: latest.reply, turn: latest.turn };
    next.turn += 1;
    next.updatedAt = now;
    this.calls.set(callId, next);
    return { reply: next.reply, turn: next.turn };
  }

  private async respond(session: Session, speech: string, now: number): Promise<Reply> {
    if (/\b(staff|human|operator|emergency)\b/i.test(speech)) {
      return say("I will try to connect you to staff. For an emergency, call your local emergency number.", true);
    }
    if (/\b(book|reserve|reschedule|confirm|yes)\b/i.test(speech)) {
      return say("Booking and rescheduling are not enabled in this mode. Nothing was changed or reserved. Say availability or staff.");
    }
    const patientNumber = selection(speech, "patient", 100);
    const fullName = patientNumber === null ? fullNameFromSpeech(speech) : null;
    if (patientNumber !== null || fullName !== null) {
      session.patientId = null;
      session.referralIds = [];
      session.selectedReferralId = null;
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
    } else if (!/^(availability|available|appointments?|repeat)[.!?]*$/i.test(speech)) {
      return say("Say availability, an offered referral number such as referral one, another patient number, or staff.");
    }
    if (!session.selectedReferralId) return say("Choose an offered referral first, for example referral one.");
    const patient = await this.store.patient(session.patientId);
    const referral = patient?.referrals.find((item) => item.referral_id === session.selectedReferralId && active(item));
    if (!referral) {
      session.selectedReferralId = null;
      session.referralIds = [];
      return say("That referral is no longer active or available. Say the patient number again to refresh the referral list.");
    }
    return this.describeAvailability(referral, now);
  }

  private async selectPatient(session: Session, patient: Patient, now: number): Promise<Reply> {
    session.patientId = patient.id;
    const referrals = patient.referrals.filter(active);
    session.referralIds = referrals.map((referral) => referral.referral_id);
    if (!referrals.length) return say("This demo patient has no active referrals awaiting scheduling. Say another patient number or fictional full name, or staff.");
    if (referrals.length === 1 && referrals[0]) {
      session.selectedReferralId = referrals[0].referral_id;
      return this.describeAvailability(referrals[0], now);
    }
    const choices = await Promise.all(referrals.map(async (referral, index) => {
      const clinic = await this.store.clinic(referral.destination_clinic_id);
      return `Referral ${index + 1}: ${referral.service.replaceAll("_", " ")} at ${clinic.name}, from ${referral.source_hospital}.`;
    }));
    return say(`${choices.join(" ")} Say referral one, referral two, or referral three as applicable.`);
  }

  private async describeAvailability(referral: Referral, now: number): Promise<Reply> {
    const clinic = await this.store.clinic(referral.destination_clinic_id);
    if (!clinic.services.includes(referral.service)) throw new Error("Referral service is not supported by its clinic");
    const slots = await this.store.availability(clinic.id, referral.service, now);
    const context = `For ${referral.service.replaceAll("_", " ")} at ${clinic.name}, from ${referral.source_hospital}:`;
    if (!slots.length) return say(`${context} no future demo slots are listed. Ask staff for help, or say another patient number.`);
    const descriptions = slots.map((slot, index) => {
      const date = new Intl.DateTimeFormat("en-US", {
        timeZone: slot.time_zone, weekday: "long", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(new Date(slot.starts_at));
      return `Option ${index + 1}: ${date}, 30 minutes.`;
    });
    return say(`${context} ${descriptions.join(" ")} These are simulated slots, not reservations. Booking is not enabled. Say availability to refresh, another patient number, or staff.`);
  }
}
