import { AsyncLocalStorage } from "node:async_hooks";
import { ZodError } from "zod";
import { StateConflict } from "./domain.ts";

export const requestContext = new AsyncLocalStorage<{ requestId: string; turn?: number }>();
type Operation = "cosmos.containers.check" | "cosmos.patient.read" | "cosmos.patient.name_query"
  | "cosmos.clinic.read" | "cosmos.slots.query" | "cosmos.referral.book"
  | "cosmos.booking.intent" | "cosmos.booking.slot" | "cosmos.booking.finalize" | "cosmos.booking.release"
  | "cosmos.booking.expire" | "azure_openai.referrals.interpret";
type Event =
  | "voice_request_started" | "voice_request_completed" | "voice_request_aborted" | "voice_request_slow"
  | "voice_request_rejected" | "voice_turn_received" | "voice_request_failed"
  | "dependency_operation_started" | "dependency_operation_completed" | "dependency_operation_failed"
  | "llm_request_blocked"
  | "relay_call_rejected" | "relay_session_started" | "relay_session_ended"
  | "relay_session_failed" | "relay_input_rejected";
type Details = {
  operation?: Operation;
  mode?: "demo" | "cloud" | "referrals";
  route?: "voice" | "handoff" | "other";
  method?: "POST" | "other";
  statusCode?: number;
  durationMs?: number;
  speechPresent?: boolean;
  category?: "state_conflict" | "request_error";
  reason?: "invalid_signature" | "invalid_payload" | "capacity" | "busy"
    | "duration_limit" | "setup_timeout" | "transport_closed" | "ended" | "provider_error";
  limit?: "process" | "rate" | "concurrency";
  requestsUsed?: number;
  requestsRemaining?: number;
  error?: ReturnType<typeof errorDetails>;
};

const knownErrorTypes = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "ModelUsageLimitError",
  "RestError", "ErrorResponse", "AggregateAuthenticationError", "CredentialUnavailableError",
  "AuthenticationError", "AuthenticationRequiredError",
  "APIError", "APIConnectionError", "APIConnectionTimeoutError", "RateLimitError",
  "BadRequestError", "PermissionDeniedError", "NotFoundError",
]);
const networkCodes = new Set([
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN",
  "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
]);
const schemaFields = new Set([
  "id", "patient_id", "clinic_id", "first_name", "last_name", "dob", "phone", "email",
  "preferred_language", "preferred_contact_method", "referrals", "referral_id",
  "source_hospital", "referring_provider", "destination_clinic_id", "service", "reason",
  "status", "received_at", "scheduling", "contact_attempts", "last_contact_at",
  "next_contact_at", "appointment_at", "is_demo", "demo_dataset", "name", "organization",
  "address", "street", "city", "state", "zip", "services", "hours", "starts_at", "ends_at", "time_zone",
  "booking", "slot_id", "requested_at", "booked_at",
  "intent", "action", "choice", "patientNumber", "fullName", "date", "period",
]);
const statusHints: Record<number, string> = {
  400: "Check the dependency request, query/schema, model support, and resource configuration.",
  401: "Check Azure login and which identity DefaultAzureCredential selected.",
  403: "Check service credentials, permissions/RBAC, and network/firewall access.",
  404: "Check the configured resource, deployment, database, container, and referenced demo records.",
  408: "The dependency timed out; inspect request duration and network connectivity.",
  429: "Dependency quota was exceeded; check Cosmos request units or Azure OpenAI token/rate limits.",
};

export function errorDetails(error: unknown) {
  const record = typeof error === "object" && error !== null ? error : {};
  const code = "code" in record ? record.code : undefined;
  const status = "statusCode" in record ? record.statusCode : "status" in record ? record.status : undefined;
  const numericStatus = typeof code === "number" && code >= 100 && code <= 599
    ? code : typeof status === "number" ? status : undefined;
  const statusCode = numericStatus !== undefined && Number.isInteger(numericStatus)
    && numericStatus >= 100 && numericStatus <= 599 ? numericStatus : undefined;
  const substatus = "substatus" in record ? record.substatus : undefined;
  const activityId = "activityId" in record ? record.activityId : undefined;
  const networkCode = typeof code === "string" && networkCodes.has(code) ? code : undefined;
  const type = error instanceof ZodError ? "ZodError" : error instanceof StateConflict ? "StateConflict"
    : error instanceof Error && knownErrorTypes.has(error.name) ? error.name : "UnknownError";
  return {
    type,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(typeof substatus === "number" && Number.isSafeInteger(substatus) ? { substatus } : {}),
    ...(typeof activityId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(activityId)
      ? { activityId } : {}),
    ...(networkCode ? { networkCode } : {}),
    ...(statusCode !== undefined && statusHints[statusCode] ? { hint: statusHints[statusCode] } : {}),
    ...(error instanceof ZodError ? {
      validationIssues: error.issues.slice(0, 10).map((issue) => ({
        code: issue.code,
        path: issue.path.map((part) => typeof part === "number" ? "[]"
          : typeof part === "string" && schemaFields.has(part) ? part : "[field]").join("."),
      })),
    } : {}),
  };
}

export function log(level: "info" | "warn" | "error", event: Event, details: Details = {}) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(), level, event, ...requestContext.getStore(), ...details,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export async function observeOperation<T>(operation: Operation, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  log("info", "dependency_operation_started", { operation });
  try {
    const result = await work();
    log("info", "dependency_operation_completed", { operation, durationMs: Math.round(performance.now() - start) });
    return result;
  } catch (error) {
    log("error", "dependency_operation_failed", {
      operation, durationMs: Math.round(performance.now() - start), error: errorDetails(error),
    });
    throw error;
  }
}
