import { z } from "zod";

const httpsUrl = z.url().refine((value) => new URL(value).protocol === "https:", "HTTPS is required");
const shared = z.object({
  MODE: z.enum(["demo", "cloud", "referrals"]).default("demo"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: httpsUrl.refine(
    (value) => {
      const url = new URL(value);
      return url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
    },
    "Use an origin only, without a path, query, credentials, or fragment",
  ).transform((value) => new URL(value).origin),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  STAFF_PHONE_NUMBER: z.union([z.literal(""), z.string().regex(/^\+[1-9]\d{7,14}$/)]).default(""),
  HOSPITAL_TIME_ZONE: z.string().default("America/New_York").refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  }, "Invalid IANA time zone"),
});

const cloud = z.object({
  COSMOS_ENDPOINT: httpsUrl,
  COSMOS_KEY: z.string().min(1),
  COSMOS_DATABASE: z.string().min(1),
  COSMOS_CONTAINER: z.string().min(1),
  ELASTICSEARCH_URL: httpsUrl,
  ELASTICSEARCH_API_KEY: z.string().min(1),
  ELASTICSEARCH_INDEX: z.string().min(1),
  AZURE_OPENAI_ENDPOINT: httpsUrl,
  AZURE_OPENAI_API_KEY: z.string().min(1),
  AZURE_OPENAI_DEPLOYMENT: z.string().min(1),
  AZURE_OPENAI_API_VERSION: z.string().min(1),
});

export function readConfig(env: NodeJS.ProcessEnv) {
  const base = shared.parse(env);
  if (base.MODE === "referrals") {
    return {
      ...base, MODE: "referrals" as const,
      referrals: z.object({ COSMOS_ENDPOINT: httpsUrl }).parse(env),
    };
  }
  return base.MODE === "cloud"
    ? { ...base, MODE: "cloud" as const, cloud: cloud.parse(env) }
    : { ...base, MODE: "demo" as const };
}

export type Config = ReturnType<typeof readConfig>;
