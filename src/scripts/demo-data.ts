import { Faker, en } from "@faker-js/faker";
import { z } from "zod";
import {
  DATASET, clinicSchema, patientSchema, referralStatuses,
  type Clinic, type Patient, type Referral, type ReferralStatus, type Scheduling,
  type SchedulingStatus, type Service,
} from "../referral-models.ts";
export * from "../referral-models.ts";

export const DEFAULT_AS_OF = "2026-11-18T12:00:00.000Z";
const day = 86_400_000;

const clinicLocations: { neighborhood: string; city: string; zip: string; services: Service[] }[] = [
  { neighborhood: "Midtown", city: "New York", zip: "10016", services: ["physical_therapy", "sports_rehab", "post_op_rehab"] },
  { neighborhood: "Upper West Side", city: "New York", zip: "10024", services: ["occupational_therapy", "neurological_rehab"] },
  { neighborhood: "Harlem", city: "New York", zip: "10027", services: ["physical_therapy", "orthopedic_rehab"] },
  { neighborhood: "Astoria", city: "Queens", zip: "11102", services: ["physical_therapy", "sports_rehab"] },
  { neighborhood: "Flushing", city: "Queens", zip: "11354", services: ["occupational_therapy", "neurological_rehab", "post_op_rehab"] },
  { neighborhood: "Park Slope", city: "Brooklyn", zip: "11215", services: ["physical_therapy", "post_op_rehab", "orthopedic_rehab"] },
  { neighborhood: "Downtown Brooklyn", city: "Brooklyn", zip: "11201", services: ["occupational_therapy", "sports_rehab"] },
  { neighborhood: "Riverdale", city: "Bronx", zip: "10471", services: ["physical_therapy", "neurological_rehab"] },
  { neighborhood: "St. George", city: "Staten Island", zip: "10301", services: ["physical_therapy", "orthopedic_rehab", "post_op_rehab"] },
  { neighborhood: "Yonkers", city: "Yonkers", zip: "10701", services: ["occupational_therapy", "neurological_rehab", "physical_therapy"] },
];
const hospitals = [
  "Demo Lantern Harbor Hospital", "Demo Paperbridge Medical Center",
  "Demo Silver Orchard Hospital", "Demo Meadow Compass Hospital",
];
const reasons: Record<Service, string[]> = {
  physical_therapy: ["Right knee mobility support", "Shoulder movement exercises"],
  occupational_therapy: ["Daily activity support", "Hand coordination exercises"],
  sports_rehab: ["Ankle return-to-activity support", "Sports mobility exercises"],
  post_op_rehab: ["Post-operative mobility referral", "Post-operative exercise support"],
  orthopedic_rehab: ["Hip mobility support", "Joint movement exercises"],
  neurological_rehab: ["Balance exercises", "Coordination and mobility support"],
};

function iso(time: number): string {
  return new Date(time).toISOString();
}

export function referenceTime(asOf: string): number {
  const parsed = z.iso.datetime().parse(asOf);
  return Date.parse(parsed);
}

export function generateClinics(): Clinic[] {
  return clinicLocations.map((location, index) => {
    const id = `clinic_${String(index + 1).padStart(3, "0")}`;
    const opens = index % 2 ? "09:00" : "08:00";
    return {
      id, clinic_id: id, is_demo: true, demo_dataset: DATASET,
      name: `Demo Lantern Rehabilitation - ${location.neighborhood}`,
      organization: index % 2 ? "Demo Paperbridge Health" : "Demo Lantern Health",
      address: {
        street: `${100 + index * 17} Fictional Lantern Way`,
        city: location.city, state: "NY", zip: location.zip,
      },
      phone: `+171855501${String(index).padStart(2, "0")}`,
      services: [...location.services],
      hours: {
        monday: `${opens}-18:00`, tuesday: `${opens}-18:00`,
        wednesday: `${opens}-${index % 3 ? "18:00" : "19:00"}`,
        thursday: `${opens}-18:00`, friday: `${opens}-17:00`,
        ...(index % 3 === 0 ? { saturday: "09:00-13:00" } : {}),
      },
    };
  });
}

function generateScheduling(status: ReferralStatus, received: number, now: number, fake: Faker): Scheduling {
  if (status === "pending_contact") {
    return {
      contact_attempts: 0, last_contact_at: null, next_contact_at: iso(now + day),
      appointment_at: null, status: "not_scheduled",
    };
  }
  const lastContact = received + day;
  const appointment = status === "scheduled"
    ? now + fake.number.int({ min: 1, max: 30 }) * day
    : status === "completed" ? lastContact + day : null;
  return {
    contact_attempts: fake.number.int({ min: status === "unable_to_reach" ? 3 : 1, max: 5 }),
    last_contact_at: iso(lastContact),
    next_contact_at: ["contacted", "scheduling", "unable_to_reach"].includes(status) ? iso(now + day) : null,
    appointment_at: appointment === null ? null : iso(appointment),
    status: status === "scheduled" || status === "completed" ? status
      : status === "scheduling" ? "scheduling" : "not_scheduled",
  };
}

export function generatePatients(clinics: Clinic[], seed = 42, asOf = DEFAULT_AS_OF): Patient[] {
  if (!Number.isSafeInteger(seed)) throw new Error("Seed must be a safe integer");
  if (!clinics.length || clinics.some((clinic) => !clinic.services.length)) {
    throw new Error("Patient generation requires clinics with supported services");
  }
  const now = referenceTime(asOf);
  const fake = new Faker({ locale: [en] });
  fake.seed(seed);
  // 80 single, 15 double and 5 triple referrals give 125 referrals.
  const referralCounts = fake.helpers.shuffle([
    ...Array<number>(80).fill(1), ...Array<number>(15).fill(2), ...Array<number>(5).fill(3),
  ]);
  const statuses = fake.helpers.shuffle(referralStatuses.flatMap((status, index) =>
    Array<ReferralStatus>([44, 19, 12, 25, 10, 6, 9][index] ?? 0).fill(status)));
  let referralIndex = 0;
  return referralCounts.map((count, patientIndex) => {
    const id = `patient_${String(patientIndex + 1).padStart(3, "0")}`;
    const sources = fake.helpers.shuffle([...hospitals]);
    const referrals = Array.from({ length: count }, (_, index): Referral => {
      const clinic = fake.helpers.arrayElement(clinics);
      const service = fake.helpers.arrayElement(clinic.services);
      const status = statuses[referralIndex];
      const source = sources[index];
      if (!status || !source) throw new Error("Missing referral generation configuration");
      referralIndex += 1;
      const received = now - fake.number.int({ min: 7, max: 60 }) * day
        - fake.number.int({ min: 0, max: 23 }) * 3_600_000;
      return {
        referral_id: `ref_${String(referralIndex).padStart(4, "0")}`,
        source_hospital: source,
        referring_provider: `Dr. Demo ${fake.person.firstName()} ${fake.person.lastName()}`,
        destination_clinic_id: clinic.id, service,
        reason: `Demo: ${fake.helpers.arrayElement(reasons[service])}`,
        status, received_at: iso(received),
        scheduling: generateScheduling(status, received, now, fake),
      };
    });
    const dob = fake.date.between({
      from: iso(now - 90 * 365.25 * day), to: iso(now - 18 * 365.25 * day),
    }).toISOString().slice(0, 10);
    return {
      id, patient_id: id, is_demo: true, demo_dataset: DATASET,
      first_name: `Demo ${fake.person.firstName()}`, last_name: fake.person.lastName(),
      dob, phone: `+121255501${String(patientIndex).padStart(2, "0")}`,
      email: `${id}@example.com`,
      preferred_language: fake.helpers.arrayElement(["en", "es", "zh", "ru"] as const),
      preferred_contact_method: fake.helpers.arrayElement(["sms", "voice"] as const),
      referrals,
    };
  });
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid demo dataset: ${message}`);
}

export function validateDemoData(clinics: Clinic[], patients: Patient[], asOf = DEFAULT_AS_OF): void {
  const now = referenceTime(asOf);
  z.array(clinicSchema).min(1).parse(clinics);
  z.array(patientSchema).min(1).parse(patients);
  const documentIds = new Set<string>();
  const referralIds = new Set<string>();
  const clinicById = new Map(clinics.map((clinic) => [clinic.id, clinic]));
  for (const document of [...clinics, ...patients]) {
    check(!documentIds.has(document.id), `duplicate document ID ${document.id}`);
    documentIds.add(document.id);
  }
  for (const clinic of clinics) {
    check(clinic.id === clinic.clinic_id, `clinic_id mismatch for ${clinic.id}`);
    for (const hours of Object.values(clinic.hours)) {
      const [opens, closes] = hours.split("-");
      check(Boolean(opens && closes && opens < closes), `invalid hours for ${clinic.id}`);
    }
  }
  for (const patient of patients) {
    check(patient.id === patient.patient_id, `patient_id mismatch for ${patient.id}`);
    check(Date.parse(patient.dob) < now, `DOB must be in the past for ${patient.id}`);
    for (const referral of patient.referrals) {
      const label = referral.referral_id;
      check(!referralIds.has(label), `duplicate referral ID ${label}`);
      referralIds.add(label);
      const clinic = clinicById.get(referral.destination_clinic_id);
      check(Boolean(clinic?.services.includes(referral.service)), `unsupported clinic/service for ${label}`);
      const received = Date.parse(referral.received_at);
      check(received <= now && received > Date.parse(patient.dob), `invalid received_at for ${label}`);
      const scheduling = referral.scheduling;
      const last = scheduling.last_contact_at === null ? null : Date.parse(scheduling.last_contact_at);
      const next = scheduling.next_contact_at === null ? null : Date.parse(scheduling.next_contact_at);
      const appointment = scheduling.appointment_at === null ? null : Date.parse(scheduling.appointment_at);
      check(last === null || (last >= received && last <= now), `invalid last_contact_at for ${label}`);
      check(next === null || (next > now && next > (last ?? received)), `invalid next_contact_at for ${label}`);
      check((scheduling.contact_attempts === 0) === (last === null), `contact attempt mismatch for ${label}`);
      const status = referral.status;
      const expected: SchedulingStatus = status === "scheduled" || status === "completed" ? status
        : status === "scheduling" ? "scheduling" : "not_scheduled";
      check(scheduling.status === expected, `scheduling status mismatch for ${label}`);
      if (status === "scheduled" || status === "completed") {
        check(appointment !== null && last !== null && appointment > last, `missing/invalid appointment for ${label}`);
        check(status === "scheduled" ? appointment > now : appointment < now, `appointment date disagrees with ${status} for ${label}`);
      } else {
        check(appointment === null, `unexpected appointment for ${label}`);
      }
      if (status !== "pending_contact") {
        check(scheduling.contact_attempts >= (status === "unable_to_reach" ? 2 : 1),
          `insufficient contact attempts for ${label}`);
      }
      if (["scheduled", "completed", "declined"].includes(status)) {
        check(next === null, `closed workflow has next_contact_at for ${label}`);
      }
    }
  }
}
