import { z } from "zod";

export const DATASET = "hospital-referrals-demo-v1";
export const REFERRALS_DATABASE = "hospital-network-db";
export const CLINICS_CONTAINER = "clinics";
export const PATIENTS_CONTAINER = "patients";
export const SLOTS_CONTAINER = "appointment_slots";
export const CLINIC_TIME_ZONE = "America/New_York";

export const referralStatuses = [
  "pending_contact", "contacted", "scheduling", "scheduled",
  "unable_to_reach", "declined", "completed",
] as const;
export const serviceSchema = z.enum([
  "physical_therapy", "occupational_therapy", "sports_rehab",
  "post_op_rehab", "orthopedic_rehab", "neurological_rehab",
]);
const schedulingStatusSchema = z.enum(["not_scheduled", "scheduling", "scheduled", "completed"]);
const contactMethodSchema = z.enum(["sms", "voice"]);
export type ReferralStatus = typeof referralStatuses[number];
export type SchedulingStatus = z.infer<typeof schedulingStatusSchema>;
export type ContactMethod = z.infer<typeof contactMethodSchema>;
export type Service = z.infer<typeof serviceSchema>;

const addressSchema = z.object({
  street: z.string().regex(/^\d+ Fictional /),
  city: z.string().min(1),
  state: z.literal("NY"),
  zip: z.string().regex(/^\d{5}$/),
});
const schedulingSchema = z.object({
  contact_attempts: z.number().int().min(0).max(10),
  last_contact_at: z.iso.datetime().nullable(),
  next_contact_at: z.iso.datetime().nullable(),
  appointment_at: z.iso.datetime().nullable(),
  status: schedulingStatusSchema,
});
const referralSchema = z.object({
  referral_id: z.string().regex(/^ref_\d{4}$/),
  source_hospital: z.string().startsWith("Demo "),
  referring_provider: z.string().startsWith("Dr. Demo "),
  destination_clinic_id: z.string(),
  service: serviceSchema,
  reason: z.string().startsWith("Demo: "),
  status: z.enum(referralStatuses),
  received_at: z.iso.datetime(),
  scheduling: schedulingSchema,
});
const demoMarker = { is_demo: z.literal(true), demo_dataset: z.literal(DATASET) };
export const clinicSchema = z.object({
  ...demoMarker,
  id: z.string().regex(/^clinic_\d{3}$/),
  clinic_id: z.string(),
  name: z.string().startsWith("Demo "),
  organization: z.string().startsWith("Demo "),
  address: addressSchema,
  phone: z.string().regex(/^\+171855501\d{2}$/),
  services: z.array(serviceSchema).min(1),
  hours: z.record(
    z.string(),
    z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/),
  ),
}).refine((clinic) => clinic.id === clinic.clinic_id, "clinic_id must equal id");
export const patientSchema = z.object({
  ...demoMarker,
  id: z.string().regex(/^patient_\d{3}$/),
  patient_id: z.string(),
  first_name: z.string().min(1).refine((value) => value.trim().length > 0, "First name must not be blank"),
  last_name: z.string().min(1),
  dob: z.iso.date(),
  phone: z.string().regex(/^\+121255501\d{2}$/),
  email: z.email().endsWith("@example.com"),
  preferred_language: z.enum(["en", "es", "zh", "ru"]),
  preferred_contact_method: contactMethodSchema,
  referrals: z.array(referralSchema).min(1).max(3),
}).refine((patient) => patient.id === patient.patient_id, "patient_id must equal id");

export type Address = z.infer<typeof addressSchema>;
export type Scheduling = z.infer<typeof schedulingSchema>;
export type Referral = z.infer<typeof referralSchema>;
export type Clinic = z.infer<typeof clinicSchema>;
export type Patient = z.infer<typeof patientSchema>;

export function normalizePatientFullName(value: string): string | null {
  // Legacy seed data used a "Demo " marker; accept both name formats.
  const name = value.normalize("NFC").trim().replace(/\s+/g, " ")
    .replace(/[’‘]/g, "'").toLowerCase().replace(/^demo /, "");
  if (name.length > 120 || !/^[\p{L}\p{M} .'-]+$/u.test(name)
    || name.split(" ").filter((word) => /\p{L}/u.test(word)).length < 2) {
    return null;
  }
  return name;
}
