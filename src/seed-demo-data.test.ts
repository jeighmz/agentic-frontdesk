import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_AS_OF, generateClinics, generatePatients, referralStatuses, validateDemoData,
  type Clinic, type Patient,
} from "./scripts/demo-data.ts";
import { main, upsertClinics, upsertPatients } from "./scripts/seed-demo-data.ts";

test("seeded generation is deterministic, varied and referentially consistent", () => {
  const clinics = generateClinics();
  const patients = generatePatients(clinics, 42);
  validateDemoData(clinics, patients);
  assert.deepEqual(generatePatients(generateClinics(), 42), patients);
  assert.notDeepEqual(generatePatients(clinics, 43), patients);
  assert.equal(clinics.length, 10);
  assert.equal(patients.length, 100);
  const referrals = patients.flatMap((patient) => patient.referrals);
  assert.equal(referrals.length, 125);
  assert.equal(patients.filter((patient) => patient.referrals.length === 1).length, 80);
  assert.equal(patients.filter((patient) => patient.referrals.length === 2).length, 15);
  assert.equal(patients.filter((patient) => patient.referrals.length === 3).length, 5);
  for (const patient of patients) {
    assert.equal(new Set(patient.referrals.map((referral) => referral.source_hospital)).size, patient.referrals.length);
  }
  assert.deepEqual(referralStatuses.map((status) => referrals.filter((referral) => referral.status === status).length),
    [44, 19, 12, 25, 10, 6, 9]);
  assert.equal(new Set(patients.map((patient) => patient.preferred_language)).size, 4);
  assert.equal(new Set(patients.map((patient) => patient.preferred_contact_method)).size, 2);
  assert.equal(new Set(referrals.map((referral) => referral.destination_clinic_id)).size, 10);
  assert.equal(new Set(referrals.map((referral) => referral.service)).size, 6);
  assert.equal(new Set(patients.map((patient) => patient.phone)).size, 100);
  const years = patients.map((patient) => Number(patient.dob.slice(0, 4)));
  assert.ok(Math.max(...years) - Math.min(...years) > 60);
});

test("all workflow timestamps are consistent across seeds and reference dates", () => {
  for (const asOf of [DEFAULT_AS_OF, "2035-05-01T10:00:00Z"]) {
    for (const seed of [0, 1, 42, -17, 1000]) {
      const clinics = generateClinics();
      const patients = generatePatients(clinics, seed, asOf);
      validateDemoData(clinics, patients, asOf);
      for (const referral of patients.flatMap((patient) => patient.referrals)) {
        const scheduling = referral.scheduling;
        if (referral.status === "scheduled" || referral.status === "completed") {
          assert.ok(scheduling.appointment_at);
          assert.equal(Date.parse(scheduling.appointment_at) > Date.parse(asOf), referral.status === "scheduled");
        }
        if (referral.status === "pending_contact") assert.equal(scheduling.contact_attempts, 0);
        if (referral.status === "unable_to_reach") {
          assert.ok(scheduling.contact_attempts >= 3);
          assert.ok(scheduling.last_contact_at);
        }
      }
    }
  }
});

test("validation rejects broken relationships, unsafe demo contacts and inconsistent states", () => {
  const mutations: { name: string; mutate: (clinics: Clinic[], patients: Patient[]) => void }[] = [
    { name: "duplicate document ID", mutate: (clinics) => { clinics.push(structuredClone(clinics[0]!)); } },
    { name: "patient ID mismatch", mutate: (_clinics, patients) => { patients[0]!.patient_id = "patient_999"; } },
    { name: "clinic ID mismatch", mutate: (clinics) => { clinics[0]!.clinic_id = "clinic_999"; } },
    { name: "unknown destination", mutate: (_clinics, patients) => { patients[0]!.referrals[0]!.destination_clinic_id = "missing"; } },
    { name: "unsupported service", mutate: (clinics, patients) => {
      patients[0]!.referrals[0]!.destination_clinic_id = clinics[0]!.id;
      patients[0]!.referrals[0]!.service = "neurological_rehab";
    } },
    { name: "duplicate referral ID", mutate: (_clinics, patients) => {
      patients[1]!.referrals[0]!.referral_id = patients[0]!.referrals[0]!.referral_id;
    } },
    { name: "non-demo email", mutate: (_clinics, patients) => { patients[0]!.email = "person@real-domain.test"; } },
    { name: "non-reserved phone", mutate: (_clinics, patients) => { patients[0]!.phone = "+12125552000"; } },
    { name: "invalid DOB", mutate: (_clinics, patients) => { patients[0]!.dob = "2026-02-30"; } },
    { name: "contact before referral", mutate: (_clinics, patients) => {
      const referral = patients.flatMap((patient) => patient.referrals).find((item) => item.status === "contacted")!;
      referral.scheduling.last_contact_at = "2000-01-01T00:00:00Z";
    } },
    { name: "future received date", mutate: (_clinics, patients) => { patients[0]!.referrals[0]!.received_at = "2099-01-01T00:00:00Z"; } },
    { name: "scheduling state mismatch", mutate: (_clinics, patients) => {
      const referral = patients.flatMap((patient) => patient.referrals).find((item) => item.status === "scheduled")!;
      referral.scheduling.status = "completed";
    } },
    { name: "scheduled appointment in past", mutate: (_clinics, patients) => {
      const referral = patients.flatMap((patient) => patient.referrals).find((item) => item.status === "scheduled")!;
      referral.scheduling.appointment_at = "2026-01-01T00:00:00Z";
    } },
    { name: "completed appointment in future", mutate: (_clinics, patients) => {
      const referral = patients.flatMap((patient) => patient.referrals).find((item) => item.status === "completed")!;
      referral.scheduling.appointment_at = "2099-01-01T00:00:00Z";
    } },
    { name: "unable to reach without attempts", mutate: (_clinics, patients) => {
      const referral = patients.flatMap((patient) => patient.referrals).find((item) => item.status === "unable_to_reach")!;
      referral.scheduling.contact_attempts = 0;
      referral.scheduling.last_contact_at = null;
    } },
  ];
  for (const { name, mutate } of mutations) {
    const clinics = generateClinics();
    const patients = generatePatients(clinics, 42);
    mutate(clinics, patients);
    assert.throws(() => validateDemoData(clinics, patients), Error, name);
  }
});

test("upserting the same IDs twice replaces only demo records and does not clear unrelated data", async () => {
  const clinics = generateClinics();
  const patients = generatePatients(clinics, 42);
  const documents = new Map<string, unknown>([["unrelated", { id: "unrelated" }]]);
  const calls: string[] = [];
  const container = {
    items: {
      async upsert(document: Clinic | Patient) {
        documents.set(document.id, structuredClone(document));
        calls.push(document.id);
      },
    },
  };
  for (let run = 0; run < 2; run += 1) {
    await upsertClinics(container, clinics);
    await upsertPatients(container, patients);
  }
  assert.equal(documents.size, 111);
  assert.equal(calls.length, 220);
  assert.deepEqual(documents.get("unrelated"), { id: "unrelated" });
  assert.deepEqual(documents.get(patients[0]!.id), patients[0]);
});

test("failed upserts propagate without reporting the remaining documents as uploaded", async () => {
  let attempts = 0;
  await assert.rejects(upsertClinics({
    items: {
      async upsert() {
        attempts += 1;
        throw new Error("Write failed");
      },
    },
  }, generateClinics()), /Write failed/);
  assert.equal(attempts, 1);
});

test("dry run validates and summarizes without requiring Azure configuration", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  await main(["--seed=42", "--dry-run"], {});
  assert.ok(logs.includes("Dataset valid."));
  assert.ok(logs.includes("Dry run: no Azure authentication or database writes performed."));
  assert.ok(logs.includes("pending_contact: 44"));
  assert.ok(!logs.includes("Uploading clinics..."));
  await assert.rejects(main(["--seed=not-a-number", "--dry-run"], {}));
  await assert.rejects(main(["--as-of=not-a-date", "--dry-run"], {}));
  await assert.rejects(main(["--seed=42"], {}));
});
