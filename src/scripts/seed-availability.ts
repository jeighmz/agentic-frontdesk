import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { generateAvailability, type AppointmentSlot } from "../availability.ts";
import { assertPartitionKey } from "../referral-store.ts";
import { CLINICS_CONTAINER, DATASET, REFERRALS_DATABASE, SLOTS_CONTAINER, clinicSchema } from "../referral-models.ts";

type SlotWriter = { items: { create(slot: AppointmentSlot): Promise<unknown> } };

export async function insertMissingSlots(container: SlotWriter, slots: AppointmentSlot[]) {
  let created = 0;
  let existing = 0;
  for (const slot of slots) {
    try {
      await container.items.create(slot);
      created += 1;
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 409) throw error;
      existing += 1;
    }
    if ((created + existing) % 100 === 0) {
      console.log(`${created + existing}/${slots.length} slots processed`);
    }
  }
  return { created, existing };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      "as-of": { type: "string", default: new Date().toISOString() },
      days: { type: "string", default: "14" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: npm run seed:availability -- [--days=14] [--as-of=2026-11-18T12:00:00Z] [--dry-run]");
    return;
  }
  const endpoint = z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash;
  }, "COSMOS_ENDPOINT must be an HTTPS origin").parse(env.COSMOS_ENDPOINT);
  const days = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(30)).parse(values.days);
  z.iso.datetime().parse(values["as-of"]);
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  try {
    const database = client.database(REFERRALS_DATABASE);
    const clinicsContainer = database.container(CLINICS_CONTAINER);
    const slotsContainer = database.container(SLOTS_CONTAINER);
    await assertPartitionKey(clinicsContainer, "/id");
    await assertPartitionKey(slotsContainer, "/clinic_id");
    const result = await clinicsContainer.items.query<unknown>({
      query: "SELECT * FROM c WHERE c.is_demo = true AND c.demo_dataset = @dataset",
      parameters: [{ name: "@dataset", value: DATASET }],
    }).fetchAll();
    const clinics = z.array(clinicSchema).min(1).parse(result.resources);
    const slots = generateAvailability(clinics, values["as-of"], days);
    console.log(`Generated and validated ${slots.length} slots for ${clinics.length} clinics over ${days} days.`);
    console.log(`Target: ${new URL(endpoint).host}/${REFERRALS_DATABASE}/${SLOTS_CONTAINER}; partition key /clinic_id`);
    if (values["dry-run"]) {
      console.log("Dry run: read existing demo clinics; no slots written.");
    } else {
      const summary = await insertMissingSlots(slotsContainer, slots);
      console.log(`Availability ready: ${summary.created} created, ${summary.existing} existing slots preserved.`);
    }
  } finally {
    client.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("Availability seeding failed; partial inserts may remain. Rerun with the same arguments after resolving the error.");
    console.error(error instanceof Error ? error.message : "Unknown availability seeding error");
    process.exitCode = 1;
  });
}
