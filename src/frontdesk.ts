import { randomUUID } from "node:crypto";
import {
  type Call, type Knowledge, type Pending, type Planner, type Reply, type State, type Store,
} from "./domain.ts";

const greeting = [
  "You have reached a synthetic hospital front desk demo. Do not share personal or medical information.",
  "All callers use the same fictional patient and schedule; no real appointments can be made.",
  "For an emergency, hang up and call your local emergency number.",
  "You can ask for appointment availability, clinic hours, or staff.",
].join(" ");

function reply(message: string, transfer = false, end = false): Reply {
  return { message, transfer, end };
}

export class Frontdesk {
  private store: Store;
  private knowledge: Knowledge;
  private planner: Planner;
  private timeZone: string;
  private now: () => number;

  constructor(options: {
    store: Store;
    knowledge: Knowledge;
    planner: Planner;
    timeZone: string;
    now?: () => number;
  }) {
    this.store = options.store;
    this.knowledge = options.knowledge;
    this.planner = options.planner;
    this.timeZone = options.timeZone;
    this.now = options.now ?? Date.now;
  }

  async handle(callId: string, turn: number, speech: string): Promise<{ reply: Reply; turn: number }> {
    const { state, version } = await this.store.load();
    const now = this.now();
    for (const [id, call] of Object.entries(state.calls)) {
      if (now - call.updatedAt > 30 * 60_000) delete state.calls[id];
    }

    let call = state.calls[callId];
    if (!call) {
      if (turn !== 0) return { reply: reply("This demo session has expired. Please call again.", false, true), turn };
      if (Object.keys(state.calls).length >= 100) {
        return { reply: reply("The demo is at capacity. Please try again later.", false, true), turn };
      }
      call = { turn: 1, pending: null, reply: reply(greeting), updatedAt: now };
      state.calls[callId] = call;
    } else {
      // Replaying Twilio's previous request must not execute a second write.
      if (turn < call.turn || call.reply.end || call.reply.transfer) {
        return { reply: call.reply, turn: call.turn };
      }
      if (turn !== call.turn) throw new Error("Unexpected voice turn");
      call.reply = call.turn >= 20
        ? reply("We have reached the demo conversation limit. I will try to connect you to staff.", true)
        : await this.respond(state, call, speech.trim(), now);
      call.turn += 1;
      call.updatedAt = now;
    }

    await this.store.save(state, version);
    return { reply: call.reply, turn: call.turn };
  }

  private describe(state: State, slotId: string): string {
    const slot = state.slots.find((item) => item.id === slotId);
    if (!slot) throw new Error("Appointment refers to a missing slot");
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: this.timeZone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(slot.startsAt));
    return `${slot.id}, ${slot.department}, ${date}, ${this.timeZone}`;
  }

  private available(state: State, now: number) {
    return state.slots.filter((slot) =>
      Date.parse(slot.startsAt) > now &&
      !state.appointments.some((appointment) => appointment.slotId === slot.id));
  }

  private validateAction(state: State, action: Pending, now: number): string | null {
    if (!this.available(state, now).some((slot) => slot.id === action.slotId)) {
      return "That slot is no longer available. Ask for availability to choose another.";
    }
    if (action.kind === "reschedule") {
      const appointment = state.appointments.find((item) =>
        item.id === action.appointmentId && item.patientId === "synthetic-patient");
      if (!appointment) return "That demo appointment was not found. Please ask for staff.";
      if (appointment.slotId !== action.originalSlotId) {
        return "That appointment changed after your request. No change was made. Ask for availability and try again.";
      }
      const currentSlot = state.slots.find((slot) => slot.id === appointment.slotId);
      if (!currentSlot || Date.parse(currentSlot.startsAt) <= now) {
        return "That appointment can no longer be rescheduled in the demo. Please ask for staff.";
      }
    }
    return null;
  }

  private async respond(state: State, call: Call, speech: string, now: number): Promise<Reply> {
    if (/^(staff|human|operator|help|emergency)[.!?]*$/i.test(speech)) {
      call.pending = null;
      return reply("I will try to connect you to staff. For an emergency, call your local emergency number.", true);
    }
    if (call.pending) {
      const confirmation = speech.toLowerCase().replace(/[.!?]/g, "").trim();
      if (["no", "no thanks", "cancel"].includes(confirmation)) {
        call.pending = null;
        return reply("The proposed change was discarded. No appointment was changed. What else can I help with?");
      }
      if (!["yes", "yes please", "confirm"].includes(confirmation)) {
        return reply(`No change has been made. ${call.reply.message}`);
      }
      const pending = call.pending;
      call.pending = null;
      const invalid = this.validateAction(state, pending, now);
      if (invalid) return reply(invalid);
      if (pending.kind === "book") {
        state.appointments.push({
          id: `appointment-${randomUUID()}`,
          patientId: "synthetic-patient",
          slotId: pending.slotId,
        });
      } else {
        const appointment = state.appointments.find((item) => item.id === pending.appointmentId);
        if (!appointment) throw new Error("Validated demo appointment disappeared");
        appointment.slotId = pending.slotId;
      }
      return reply(`Your demo appointment is ${pending.kind === "book" ? "booked" : "rescheduled"} for ${this.describe(state, pending.slotId)}. This is not a real appointment. What else can I help with?`);
    }
    if (!speech) return reply("I did not hear a response. Ask for availability, clinic hours, or staff.");
    if (/^(yes|confirm)[.!?]*$/i.test(speech)) return reply("There is no appointment change awaiting confirmation.");

    const faqs = await this.knowledge.search(speech);
    const slots = this.available(state, now).map((slot) => ({
      id: slot.id,
      description: this.describe(state, slot.id),
    }));
    const appointments = state.appointments.map((appointment) => ({
      id: appointment.id,
      description: this.describe(state, appointment.slotId),
    }));
    const decision = await this.planner.decide({
      speech, previousPrompt: call.reply.message, slots, appointments, faqs,
    });

    switch (decision.action) {
      case "handoff":
        return reply("This request needs staff assistance. I will try to connect you.", true);
      case "availability":
        return reply([
          appointments.length ? `Demo appointments: ${appointments.map((item) => `${item.id}: ${item.description}`).join(". ")}.` : "",
          slots.length ? `Available demo slots: ${slots.slice(0, 3).map((slot) => slot.description).join(". ")}.` : "There are no available demo slots.",
          "To book, say book and a slot ID. To move the original appointment, say reschedule appointment-demo to a slot ID.",
        ].filter(Boolean).join(" "));
      case "faq": {
        const faq = faqs.find((item) => item.id === decision.faqId);
        return faq
          ? reply(`${faq.answer} Source: ${faq.title}. What else can I help with?`)
          : reply("I could not find approved information for that question. I will try to connect you to staff.", true);
      }
      case "book":
      case "reschedule": {
        if (!decision.slotId) return reply("No change was made. Ask for availability, then specify a slot.");
        const pending: Pending = {
          kind: decision.action,
          slotId: decision.slotId,
          appointmentId: decision.action === "reschedule" ? decision.appointmentId : null,
          originalSlotId: decision.action === "reschedule"
            ? state.appointments.find((item) => item.id === decision.appointmentId)?.slotId ?? null
            : null,
        };
        const invalid = this.validateAction(state, pending, now);
        if (invalid) return reply(invalid);
        call.pending = pending;
        let operation = "book a new demo appointment";
        if (pending.kind === "reschedule") {
          if (!pending.originalSlotId) throw new Error("Validated reschedule has no original slot");
          operation = `move demo appointment ${pending.appointmentId} from ${this.describe(state, pending.originalSlotId)}`;
        }
        return reply(`Shall I ${operation} to ${this.describe(state, pending.slotId)}? Say yes to confirm or no to discard this change.`);
      }
    }
  }
}
