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
}).refine((slot) => Date.parse(slot.ends_at) - Date.parse(slot.starts_at) === 30 * 60_000,
  "Slots must last 30 minutes");
export type AppointmentSlot = z.infer<typeof slotSchema>;

const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

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
