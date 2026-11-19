import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { AzureOpenAI } from "openai";
import { readConfig } from "./config.ts";
import { AzureReferralInterpreter, type ReferralContext, type ReferralIntent } from "./referral-interpreter.ts";
import { AzurePlanner } from "./adapters.ts";
import { ModelRequestGuard, ModelUsageLimitError } from "./model-guard.ts";

beforeEach(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
  mock.method(console, "warn", () => {});
});
afterEach(() => mock.restoreAll());

const config = {
  AZURE_OPENAI_ENDPOINT: "https://openai.example.com",
  AZURE_OPENAI_DEPLOYMENT: "test-deployment",
  AZURE_OPENAI_API_VERSION: "2024-10-21",
};
const cloudConfig = {
  ...config,
  AZURE_OPENAI_API_KEY: "synthetic-test-key",
  COSMOS_ENDPOINT: "https://cosmos.example.com", COSMOS_KEY: "synthetic-test-key",
  COSMOS_DATABASE: "test-db", COSMOS_CONTAINER: "test-container",
  ELASTICSEARCH_URL: "https://search.example.com", ELASTICSEARCH_API_KEY: "synthetic-test-key",
  ELASTICSEARCH_INDEX: "test-index",
};
const context: ReferralContext = {
  speech: "The second appointment works for me.",
  localDate: "2026-11-18", timeZone: "America/New_York",
  patientSelected: true, referralSelected: true, referralCount: 1,
  preference: { date: null, period: null },
  pendingConfirmation: null,
  slots: [{ option: 1, localTime: "Thursday at 9 AM" }, { option: 2, localTime: "Thursday at 9:30 AM" }],
};
const intent: ReferralIntent = {
  action: "choose_slot", choice: 2,
};

function completion(value: unknown, finishReason = "tool_calls", name = "referral_intent", callCount = 1) {
  return {
    id: "synthetic-completion", object: "chat.completion", created: 0, model: "test-deployment",
    choices: [{
      index: 0, finish_reason: finishReason,
      message: {
        role: "assistant", content: null, refusal: null,
        tool_calls: Array.from({ length: callCount }, (_, index) => ({
          id: `synthetic-tool-${index}`, type: "function", function: { name, arguments: JSON.stringify({ intent: value }) },
        })),
      },
    }],
  };
}

function interpreter(response: unknown, status = 200, guard = new ModelRequestGuard()) {
  const requests: unknown[] = [];
  const sdk = new AzureOpenAI({
    endpoint: config.AZURE_OPENAI_ENDPOINT, apiVersion: config.AZURE_OPENAI_API_VERSION,
    apiKey: "synthetic-test-key", maxRetries: 0,
    fetch: async (_url, init) => {
      assert.equal(typeof init?.body, "string");
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
    },
  });
  return { planner: new AzureReferralInterpreter(config, sdk, guard), requests, sdk };
}

test("Azure routing uses a single bounded function decision, not model-generated spoken responses", async () => {
  const { planner, requests } = interpreter(completion(intent));
  assert.deepEqual(await planner.interpret(context), intent);
  assert.equal(requests.length, 1);
  const body = requests[0];
  assert.ok(typeof body === "object" && body !== null && "max_completion_tokens" in body);
  assert.ok(typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens <= 256);
  assert.ok("parallel_tool_calls" in body && body.parallel_tool_calls === false);
  assert.match(JSON.stringify(body), /referral_intent/);
  const azureStop = interpreter(completion(intent, "stop"));
  assert.deepEqual(await azureStop.planner.interpret(context), intent);
  assert.equal(azureStop.requests.length, 1);
});

test("malformed, truncated, fabricated and unknown tool decisions are rejected", async () => {
  for (const response of [
    completion({ ...intent, choice: 4 }),
    completion({ ...intent, action: "confirm" }),
    completion({ ...intent, slotId: "fabricated-slot" }),
    completion({ ...intent, patientNumber: 1 }),
    completion({ ...intent, choice: null }),
    completion(intent, "length"),
    completion(intent, "tool_calls", "book_appointment"),
    completion(intent, "tool_calls", "referral_intent", 2),
    { choices: [{ finish_reason: "stop", message: { content: "Your appointment is booked!" } }] },
  ]) {
    const { planner } = interpreter(response);
    await assert.rejects(planner.interpret(context));
  }
});

test("Azure adapter accepts natural confirmation decisions with pending appointment context", async () => {
  for (const action of ["confirm_booking", "decline_booking", "clarify"] as const) {
    const { planner } = interpreter(completion({ action }));
    assert.deepEqual(await planner.interpret({
      ...context,
      speech: action === "confirm_booking" ? "Yes, that time works for me"
        : action === "decline_booking" ? "Please do not book that" : "Maybe, can it be later?",
      pendingConfirmation: { localTime: "Thursday at 9:30 AM", submitted: false },
    }), { action });
  }
});

test("Azure failures are surfaced once with sanitized status metadata, not success-shaped fallbacks", async (t) => {
  const entries: string[] = [];
  t.mock.method(console, "error", (entry: string) => entries.push(entry));
  const privateMessage = "synthetic-sensitive-provider-error";
  const { planner, requests } = interpreter({ error: { message: privateMessage } }, 503);
  await assert.rejects(planner.interpret(context));
  assert.equal(requests.length, 1);
  assert.match(entries.join(), /"statusCode":503/);
  assert.ok(!entries.join().includes(privateMessage));
  assert.ok(!entries.join().includes(context.speech));
});

test("both Azure adapters reject overlapping requests before sending HTTP", async () => {
  const guard = new ModelRequestGuard();
  const release = Promise.withResolvers<void>();
  const pending = guard.run(() => release.promise);
  const { planner, requests, sdk } = interpreter(completion(intent), 200, guard);
  const cloud = new AzurePlanner(cloudConfig, sdk, guard);
  try {
    await assert.rejects(planner.interpret(context), ModelUsageLimitError);
    await assert.rejects(cloud.decide({
      speech: "availability", previousPrompt: "", slots: [], appointments: [], faqs: [],
    }), ModelUsageLimitError);
    assert.equal(requests.length, 0);
  } finally {
    release.resolve();
    await pending;
  }
  assert.deepEqual(await planner.interpret(context), intent);
  assert.equal(requests.length, 1);
});

test("cloud planner requests also have a bounded output size", async () => {
  const decision = { action: "availability", slotId: null, appointmentId: null, faqId: null };
  const response = completion(decision, "tool_calls", "frontdesk_decision");
  const tool = response.choices[0]?.message.tool_calls[0];
  assert.ok(tool);
  tool.function.arguments = JSON.stringify(decision);
  const guard = new ModelRequestGuard();
  const { sdk, requests } = interpreter(response, 200, guard);
  const planner = new AzurePlanner(cloudConfig, sdk, guard);
  assert.deepEqual(await planner.decide({
    speech: "availability", previousPrompt: "", slots: [], appointments: [], faqs: [],
  }), decision);
  const body = requests[0];
  assert.ok(typeof body === "object" && body !== null && "max_completion_tokens" in body);
  assert.ok(typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens <= 256);
});

test("a failing provider loop sends at most one hundred HTTP requests per guard lifetime", async () => {
  let now = 0;
  const guard = new ModelRequestGuard(() => now);
  const { planner, requests } = interpreter({ error: { message: "Synthetic provider failure" } }, 503, guard);
  for (let index = 0; index < 100; index += 1) {
    now = index * 6_000;
    await assert.rejects(planner.interpret(context), { status: 503 });
  }
  now += 60 * 60_000;
  await assert.rejects(planner.interpret(context),
    (error) => error instanceof ModelUsageLimitError && error.limit === "process");
  assert.equal(requests.length, 100);
});

test("referral AI is opt-in and uses Azure configuration without requiring search or a key", () => {
  const base = {
    MODE: "referrals", PUBLIC_BASE_URL: "https://voice.example.com",
    TWILIO_AUTH_TOKEN: "synthetic-test-token", COSMOS_ENDPOINT: "https://cosmos.example.com",
  };
  const disabled = readConfig(base);
  assert.equal(disabled.MODE, "referrals");
  if (disabled.MODE !== "referrals") throw new Error("Unexpected mode");
  assert.equal(disabled.referrals.openai, null);
  assert.throws(() => readConfig({ ...base, REFERRAL_AI_ENABLED: "true" }));
  assert.throws(() => readConfig({ ...base, REFERRAL_AI_ENABLED: "not-a-boolean" }));
  const enabled = readConfig({ ...base, ...config, REFERRAL_AI_ENABLED: "true" });
  if (enabled.MODE !== "referrals") throw new Error("Unexpected mode");
  assert.ok(enabled.referrals.openai);
  assert.equal(enabled.referrals.openai.AZURE_OPENAI_DEPLOYMENT, config.AZURE_OPENAI_DEPLOYMENT);
});
