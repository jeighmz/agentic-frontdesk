import type { PatchOperation, RequestOptions } from "@azure/cosmos";
import type { BookingDocuments } from "../booking.ts";
import { slotSchema, type AppointmentSlot } from "../availability.ts";
import { patientSchema, type Clinic, type Patient } from "../referral-models.ts";

type PatchEvent = { container: "patients" | "slots"; id: string; operations: PatchOperation[]; phase: "before" | "after" };

export function memoryBookingDocuments(clinics: Clinic[], patients: Patient[], slots: AppointmentSlot[]) {
  const data = new Map<string, { value: unknown; version: number }>();
  const key = (container: string, id: string, partition: string) => `${container}/${partition}/${id}`;
  for (const clinic of clinics) data.set(key("clinics", clinic.id, clinic.id), { value: structuredClone(clinic), version: 1 });
  for (const patient of patients) data.set(key("patients", patient.id, patient.id), { value: structuredClone(patient), version: 1 });
  for (const slot of slots) data.set(key("slots", slot.id, slot.clinic_id), { value: structuredClone(slot), version: 1 });
  const writes: PatchEvent[] = [];
  let hook: ((event: PatchEvent) => void | Promise<void>) | undefined;
  const item = (container: "patients" | "slots" | "clinics", id: string, partition: string) => ({
    async read() {
      const current = data.get(key(container, id, partition));
      return current
        ? { resource: structuredClone(current.value), etag: String(current.version), statusCode: 200 }
        : { statusCode: 404 };
    },
    async patch(operations: PatchOperation[], options: RequestOptions) {
      if (container === "clinics") throw new Error("Clinic writes are not supported");
      const event = { container, id, operations, phase: "before" as const };
      if (hook) await hook(event);
      const current = data.get(key(container, id, partition));
      if (!current) throw Object.assign(new Error("Missing document"), { code: 404 });
      if (options.accessCondition?.type !== "IfMatch" || options.accessCondition.condition !== String(current.version)) {
        throw Object.assign(new Error("ETag changed"), { code: 412 });
      }
      const value = structuredClone(current.value);
      for (const operation of operations) {
        const segments = operation.path.split("/").slice(1);
        const field = segments.pop();
        if (!field) throw new Error("Invalid patch path");
        let parent: unknown = value;
        for (const segment of segments) {
          if (typeof parent !== "object" || parent === null) throw new Error("Missing patch parent");
          parent = Reflect.get(parent, segment);
        }
        if (typeof parent !== "object" || parent === null) throw new Error("Invalid patch parent");
        if (operation.op === "remove") {
          Reflect.deleteProperty(parent, field);
        } else if (operation.op === "add" || operation.op === "replace") {
          Reflect.set(parent, field, operation.value);
        } else {
          throw new Error("Unsupported test patch operation");
        }
      }
      data.set(key(container, id, partition), { value, version: current.version + 1 });
      writes.push({ ...event, phase: "after" });
      if (hook) await hook({ ...event, phase: "after" });
    },
  });
  const documents: BookingDocuments = {
    patients: { item: (id, partition) => item("patients", id, partition) },
    slots: { item: (id, partition) => item("slots", id, partition) },
    clinics: { item: (id, partition) => item("clinics", id, partition) },
  };
  return {
    documents, writes,
    setHook(value: typeof hook) { hook = value; },
    storedPatient(id: string) { return patientSchema.parse(data.get(key("patients", id, id))?.value); },
    storedSlot(id: string, clinicId: string) { return slotSchema.parse(data.get(key("slots", id, clinicId))?.value); },
  };
}
