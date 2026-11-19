import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { CLINIC_TIME_ZONE, clinicSchema, serviceSchema, type Clinic } from "./referral-models.ts";

export const AVAILABILITY_DATASET = "hospital-availability-demo-v1";
export const slotSchema = z.object({
  id: z.string().min(1),
  clinic_id: z.string().regex(/^clinic_\d{3}$/),
  service: serviceSchema,
  starts_at: z.iso.datetime(),
  ends_at: z.iso.datetime(),
  time_zone: z.literal(CLINIC_TIME_ZONE),
  status: z.enum(["available", "booked", "blocked"]),
  is_demo: z.literal(true),
  demo_dataset: z.literal(AVAILABILITY_DATASET),
  booking: z.object({
    id: z.uuid(),
    patient_id: z.string(),
    referral_id: z.string(),
    booked_at: z.iso.datetime(),
  }).optional(),
}).refine((slot) => Date.parse(slot.ends_at) - Date.parse(slot.starts_at) === 30 * 60_000,
  "Slots must last 30 minutes")
  .refine((slot) => !slot.booking || slot.status === "booked", "Owned slots must be booked");
export type AppointmentSlot = z.infer<typeof slotSchema>;

export const availabilityPreferenceSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  period: z.enum(["morning", "afternoon", "evening"]).nullable(),
});
export type AvailabilityPreference = z.infer<typeof availabilityPreferenceSchema>;
const windowSchema = z.object({ start: z.iso.datetime(), end: z.iso.datetime() })
  .refine((window) => Date.parse(window.start) < Date.parse(window.end), "Availability window must have positive duration");
export const availabilityWindowsSchema = z.array(windowSchema).max(31);
export type AvailabilityWindow = z.infer<typeof windowSchema>;

export function availabilityWindows(preference: AvailabilityPreference, now: number): AvailabilityWindow[] {
  availabilityPreferenceSchema.parse(preference);
  if (!preference.date && !preference.period) return [];
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(CLINIC_TIME_ZONE).toPlainDate();
  const first = preference.date ? Temporal.PlainDate.from(preference.date) : today;
  if (Temporal.PlainDate.compare(first, today) < 0 || Temporal.PlainDate.compare(first, today.add({ days: 30 })) > 0) {
    throw new RangeError("Choose a date from today through the next 30 days");
  }
  const times = preference.period === "morning" ? ["00:00", "12:00"]
    : preference.period === "afternoon" ? ["12:00", "17:00"]
      : preference.period === "evening" ? ["17:00", "24:00"] : ["00:00", "24:00"];
  const [opens, closes] = times;
  if (!opens || !closes) throw new Error("Missing availability window times");
  return Array.from({ length: preference.date ? 1 : 31 }, (_, index) => {
    const date = first.add({ days: index });
    const start = date.toZonedDateTime({ timeZone: CLINIC_TIME_ZONE, plainTime: opens });
    const end = closes === "24:00"
      ? date.add({ days: 1 }).toZonedDateTime({ timeZone: CLINIC_TIME_ZONE, plainTime: "00:00" })
      : date.toZonedDateTime({ timeZone: CLINIC_TIME_ZONE, plainTime: closes });
    return {
      start: start.toInstant().toString({ fractionalSecondDigits: 3 }),
      end: end.toInstant().toString({ fractionalSecondDigits: 3 }),
    };
  });
}

const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function slotFitsClinic(slot: AppointmentSlot, clinic: Clinic): boolean {
  if (slot.clinic_id !== clinic.id || !clinic.services.includes(slot.service)) return false;
  const start = Temporal.Instant.from(slot.starts_at).toZonedDateTimeISO(CLINIC_TIME_ZONE);
  const end = Temporal.Instant.from(slot.ends_at).toZonedDateTimeISO(CLINIC_TIME_ZONE);
  const weekday = weekdays[start.dayOfWeek - 1];
  const hours = weekday ? clinic.hours[weekday] : undefined;
  if (!hours || !start.toPlainDate().equals(end.toPlainDate())) return false;
  const [opens, closes] = hours.split("-");
  return Boolean(opens && closes
    && Temporal.PlainTime.compare(start.toPlainTime(), Temporal.PlainTime.from(opens)) >= 0
    && Temporal.PlainTime.compare(end.toPlainTime(), Temporal.PlainTime.from(closes)) <= 0);
}

export function generateAvailability(clinics: Clinic[], asOf: string, days = 14): AppointmentSlot[] {
  z.number().int().min(1).max(30).parse(days);
  z.array(clinicSchema).min(1).parse(clinics);
  const firstDay = Temporal.Instant.from(asOf).toZonedDateTimeISO(CLINIC_TIME_ZONE).toPlainDate().add({ days: 1 });
  const slots: AppointmentSlot[] = [];
  const ids = new Set<string>();
  for (const clinic of clinics) {
    for (let offset = 0; offset < days; offset += 1) {
      const date = firstDay.add({ days: offset });
      const weekday = weekdays[date.dayOfWeek - 1];
      if (!weekday) throw new Error("Invalid weekday");
      const hours = clinic.hours[weekday];
      if (!hours) continue;
      const [opens, closes] = hours.split("-");
      if (!opens || !closes || opens >= closes) throw new Error(`Invalid opening hours for ${clinic.id}`);
      let start = date.toZonedDateTime({ timeZone: CLINIC_TIME_ZONE, plainTime: opens });
      const close = date.toZonedDateTime({ timeZone: CLINIC_TIME_ZONE, plainTime: closes });
      while (Temporal.ZonedDateTime.compare(start.add({ minutes: 30 }), close) <= 0) {
        const startsAt = start.toInstant().toString({ fractionalSecondDigits: 3 });
        const endsAt = start.add({ minutes: 30 }).toInstant().toString({ fractionalSecondDigits: 3 });
        for (const service of clinic.services) {
          const id = `slot_${clinic.id}_${service}_${start.epochMilliseconds}`;
          if (ids.has(id)) throw new Error(`Duplicate generated slot: ${id}`);
          ids.add(id);
          slots.push(slotSchema.parse({
            id, clinic_id: clinic.id, service, starts_at: startsAt, ends_at: endsAt,
            time_zone: CLINIC_TIME_ZONE, status: "available", is_demo: true,
            demo_dataset: AVAILABILITY_DATASET,
          }));
        }
        start = start.add({ minutes: 30 });
      }
    }
  }
  return slots;
}
