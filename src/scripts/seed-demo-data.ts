import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  DEFAULT_AS_OF, generateClinics, generatePatients, referenceTime, referralStatuses, validateDemoData,
  type Clinic, type Patient,
} from "./demo-data.ts";

export const DATABASE = "hospital-network-db";
export const CLINICS_CONTAINER = "clinics";
export const PATIENTS_CONTAINER = "patients";

type UpsertContainer = {
  items: { upsert(document: Clinic | Patient): Promise<unknown> };
};

export async function upsertClinics(container: UpsertContainer, clinics: Clinic[]): Promise<void> {
  for (const clinic of clinics) await container.items.upsert(clinic);
}

export async function upsertPatients(container: UpsertContainer, patients: Patient[]): Promise<void> {
  for (const patient of patients) await container.items.upsert(patient);
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      seed: { type: "string", default: "42" },
      "as-of": { type: "string", default: DEFAULT_AS_OF },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: npm run seed:demo -- [--seed=42] [--as-of=2026-11-18T12:00:00Z] [--dry-run]");
    return;
  }
  const seed = z.string().regex(/^-?\d+$/).transform(Number).pipe(z.number().int().safe()).parse(values.seed);
  const asOf = values["as-of"];
  const reference = referenceTime(asOf);
  console.log("Generating demo dataset...");
  console.log(`Seed: ${seed}; reference time: ${new Date(reference).toISOString()}`);
  const clinics = generateClinics();
  const patients = generatePatients(clinics, seed, asOf);
  const referrals = patients.flatMap((patient) => patient.referrals);
  console.log(`Clinics: ${clinics.length}\nPatients: ${patients.length}\nReferrals: ${referrals.length}`);
  console.log("Validating dataset...");
  validateDemoData(clinics, patients, asOf);
  console.log("Dataset valid.");

  if (values["dry-run"]) {
    console.log("Dry run: no Azure authentication or database writes performed.");
  } else {
    const endpoint = z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password
        && url.pathname === "/" && !url.search && !url.hash;
    }, "COSMOS_ENDPOINT must be an HTTPS origin").parse(env.COSMOS_ENDPOINT);
    console.log(`Target: ${new URL(endpoint).host}/${DATABASE} (${CLINICS_CONTAINER}, ${PATIENTS_CONTAINER})`);
    const credential = new DefaultAzureCredential();
    const client = new CosmosClient({ endpoint, aadCredentials: credential });
    try {
      const database = client.database(DATABASE);
      const clinicsContainer = database.container(CLINICS_CONTAINER);
      const patientsContainer = database.container(PATIENTS_CONTAINER);
      // Check both existing containers before the first write.
      for (const container of [clinicsContainer, patientsContainer]) {
        const { resource } = await container.read();
        if (resource?.partitionKey?.paths.length !== 1 || resource.partitionKey.paths[0] !== "/id") {
          throw new Error(`Container ${container.id} must exist with partition key /id`);
        }
      }
      console.log("Uploading clinics...");
      await upsertClinics(clinicsContainer, clinics);
      console.log(`${clinics.length}/${clinics.length} clinics uploaded`);
      console.log("Uploading patients...");
      await upsertPatients(patientsContainer, patients);
      console.log(`${patients.length}/${patients.length} patients uploaded`);
    } finally {
      client.dispose();
    }
  }
  console.log("\nReferral Status Summary\n-----------------------");
  for (const status of referralStatuses) {
    console.log(`${status}: ${referrals.filter((referral) => referral.status === status).length}`);
  }
  console.log(values["dry-run"] ? "\nDemo data validation complete." : "\nDemo data ingestion complete.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("Demo ingestion failed. Some upserts may have completed; rerun with the same seed/reference time after fixing the error.");
    console.error(error instanceof Error ? error.message : "Unknown ingestion error");
    process.exitCode = 1;
  });
}
