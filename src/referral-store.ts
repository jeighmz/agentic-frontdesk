import { CosmosClient, type Container, type SqlQuerySpec } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { AVAILABILITY_DATASET, slotSchema, type AppointmentSlot } from "./availability.ts";
import {
  CLINICS_CONTAINER, PATIENTS_CONTAINER, REFERRALS_DATABASE, SLOTS_CONTAINER,
  clinicSchema, patientSchema, type Clinic, type Patient, type Service,
} from "./referral-models.ts";

export interface ReferralStore {
  patient(id: string): Promise<Patient | null>;
  clinic(id: string): Promise<Clinic>;
  availability(clinicId: string, service: Service, now: number): Promise<AppointmentSlot[]>;
}

export function availabilityQuery(service: Service, now: number): SqlQuerySpec {
  return {
    query: `SELECT TOP 3 * FROM c WHERE c.is_demo = true AND c.demo_dataset = @dataset
      AND c.service = @service AND c.status = "available" AND c.starts_at > @now
      ORDER BY c.starts_at ASC`,
    parameters: [
      { name: "@dataset", value: AVAILABILITY_DATASET },
      { name: "@service", value: service },
      { name: "@now", value: new Date(now).toISOString() },
    ],
  };
}

export async function assertPartitionKey(container: Container, key: string): Promise<void> {
  const { resource } = await container.read();
  if (resource?.partitionKey?.paths.length !== 1 || resource.partitionKey.paths[0] !== key) {
    throw new Error(`Container ${container.id} must exist with partition key ${key}`);
  }
}

type SlotReader = {
  items: {
    query(query: SqlQuerySpec, options: { partitionKey: string }): {
      fetchAll(): Promise<{ resources: unknown[] }>;
    };
  };
};

export async function readAvailableSlots(
  container: SlotReader, clinicId: string, service: Service, now: number,
): Promise<AppointmentSlot[]> {
  const result = await container.items.query(availabilityQuery(service, now), {
    partitionKey: clinicId,
  }).fetchAll();
  return result.resources.map((document) => {
    const slot = slotSchema.parse(document);
    if (slot.clinic_id !== clinicId || slot.service !== service || slot.status !== "available"
      || Date.parse(slot.starts_at) <= now) {
      throw new Error("Cosmos returned a slot inconsistent with the availability request");
    }
    return slot;
  });
}

export class CosmosReferralStore implements ReferralStore {
  private client: CosmosClient;
  private patients: Container;
  private clinics: Container;
  private slots: Container;

  constructor(endpoint: string) {
    this.client = new CosmosClient({
      endpoint,
      aadCredentials: new DefaultAzureCredential(),
      connectionPolicy: { requestTimeout: 2500, retryOptions: { maxRetryAttemptCount: 0 } },
    });
    const database = this.client.database(REFERRALS_DATABASE);
    this.patients = database.container(PATIENTS_CONTAINER);
    this.clinics = database.container(CLINICS_CONTAINER);
    this.slots = database.container(SLOTS_CONTAINER);
  }

  async checkContainers() {
    await Promise.all([
      assertPartitionKey(this.patients, "/id"),
      assertPartitionKey(this.clinics, "/id"),
      assertPartitionKey(this.slots, "/clinic_id"),
    ]);
  }

  async patient(id: string): Promise<Patient | null> {
    const result = await this.patients.item(id, id).read();
    if (result.statusCode === 404) return null;
    return patientSchema.parse(result.resource);
  }

  async clinic(id: string): Promise<Clinic> {
    const result = await this.clinics.item(id, id).read();
    return clinicSchema.parse(result.resource);
  }

  async availability(clinicId: string, service: Service, now: number): Promise<AppointmentSlot[]> {
    return readAvailableSlots(this.slots, clinicId, service, now);
  }

  close() {
    this.client.dispose();
  }
}
