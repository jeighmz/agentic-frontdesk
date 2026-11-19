import { z } from "zod";

export const replySchema = z.object({
  message: z.string(),
  transfer: z.boolean().default(false),
  end: z.boolean().default(false),
});
export type Reply = z.infer<typeof replySchema>;
export interface VoiceHandler {
  handle(callId: string, turn: number, speech: string): Promise<{ reply: Reply; turn: number }>;
}

const pendingSchema = z.object({
  kind: z.enum(["book", "reschedule"]),
  slotId: z.string(),
  appointmentId: z.string().nullable(),
  originalSlotId: z.string().nullable(),
});
export type Pending = z.infer<typeof pendingSchema>;

export const stateSchema = z.object({
  id: z.literal("synthetic-frontdesk"),
  slots: z.array(z.object({
    id: z.string(),
    startsAt: z.iso.datetime(),
    department: z.string(),
  })),
  appointments: z.array(z.object({
    id: z.string(),
    patientId: z.literal("synthetic-patient"),
    slotId: z.string(),
  })),
  calls: z.record(z.string(), z.object({
    turn: z.number().int().nonnegative(),
    pending: pendingSchema.nullable(),
    reply: replySchema,
    updatedAt: z.number(),
  })),
});
export type State = z.infer<typeof stateSchema>;
export type Call = State["calls"][string];

export type Faq = { id: string; title: string; answer: string };
export const faqSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  answer: z.string().min(1).max(1200),
});

export const decisionSchema = z.object({
  action: z.enum(["availability", "book", "reschedule", "faq", "handoff"]),
  slotId: z.string().nullable(),
  appointmentId: z.string().nullable(),
  faqId: z.string().nullable(),
});
export type Decision = z.infer<typeof decisionSchema>;
export type PlanningContext = {
  speech: string;
  previousPrompt: string;
  slots: { id: string; description: string }[];
  appointments: { id: string; description: string }[];
  faqs: Faq[];
};
export interface Planner {
  decide(context: PlanningContext): Promise<Decision>;
}
export interface Knowledge {
  search(query: string): Promise<Faq[]>;
}
export interface Store {
  load(): Promise<{ state: State; version: string }>;
  save(state: State, version: string): Promise<void>;
}
export class StateConflict extends Error {}

export function seedState(now = new Date()): State {
  const slots = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + 1 + Math.floor(index / 2));
    date.setUTCHours(14 + index % 2, 0, 0, 0);
    return { id: `slot-${index + 1}`, startsAt: date.toISOString(), department: "Demo general clinic" };
  });
  return {
    id: "synthetic-frontdesk",
    slots,
    appointments: [{ id: "appointment-demo", patientId: "synthetic-patient", slotId: "slot-1" }],
    calls: {},
  };
}

export const demoFaqs: Faq[] = [
  {
    id: "hours",
    title: "Synthetic clinic hours",
    answer: "This fictional clinic is open Monday through Friday from 9 AM to 5 PM. These are demo hours, not real hospital information.",
  },
  {
    id: "parking",
    title: "Synthetic clinic parking",
    answer: "For this demo, visitor parking is in the fictional north garage. Ask real hospital staff for actual directions.",
  },
];
