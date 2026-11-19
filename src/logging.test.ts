import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { z } from "zod";
import twilio from "twilio";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { errorDetails, observeOperation, requestContext } from "./logging.ts";
import { ModelUsageLimitError } from "./model-guard.ts";

test("error diagnostics expose safe Cosmos metadata but never arbitrary error content", () => {
  const secret = "sensitive-patient-and-credential-content";
  const error = Object.assign(new Error(secret), {
    code: 403, substatus: 5301, activityId: "12345678-1234-1234-1234-123456789abc",
    body: secret, headers: { authorization: secret }, stack: secret,
  });
  const details = errorDetails(error);
  assert.equal(details.statusCode, 403);
  assert.equal(details.substatus, 5301);
  assert.equal(details.activityId, error.activityId);
  assert.match(details.hint ?? "", /RBAC/);
  assert.ok(!JSON.stringify(details).includes(secret));
  assert.ok(!JSON.stringify(errorDetails({ code: secret, activityId: secret })).includes(secret));
  assert.equal(errorDetails(Object.assign(new Error(secret), { code: "ETIMEDOUT" })).networkCode, "ETIMEDOUT");
});

test("schema failures identify fields without logging values or validation messages", () => {
  const secret = "private-value-never-log";
  const parsed = z.object({
    email: z.literal("expected@example.com"),
    referrals: z.array(z.object({ status: z.literal("scheduled") })),
  }).safeParse({ email: secret, referrals: [{ status: secret }] });
  assert.ok(!parsed.success);
  const details = errorDetails(parsed.error);
  assert.equal(details.type, "ZodError");
  assert.deepEqual(details.validationIssues?.map((issue) => issue.path), ["email", "referrals.[].status"]);
  assert.ok(!JSON.stringify(details).includes(secret));
  const dynamic = z.record(z.string(), z.literal("expected")).safeParse({ [secret]: secret });
  assert.ok(!dynamic.success);
  assert.ok(!JSON.stringify(errorDetails(dynamic.error)).includes(secret));
});

test("dependency operations preserve errors and isolate concurrent request correlation", async (t) => {
  const infos: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, "log", (entry: string) => infos.push(entry));
  t.mock.method(console, "error", (entry: string) => errors.push(entry));
  const cause = Object.assign(new Error("private diagnostic detail"), { code: 429 });
  await Promise.all([
    requestContext.run({ requestId: "request-one", turn: 1 }, () =>
      observeOperation("cosmos.patient.read", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "ok";
      })),
    requestContext.run({ requestId: "request-two", turn: 2 }, async () => {
      await assert.rejects(observeOperation("cosmos.slots.query", async () => { throw cause; }),
        (error) => error === cause);
    }),
  ]);
  const completed = infos.map((entry) => JSON.parse(entry)).find((entry) => entry.event === "dependency_operation_completed");
  assert.equal(completed.requestId, "request-one");
  assert.equal(completed.operation, "cosmos.patient.read");
  const failed = JSON.parse(errors[0] ?? "{}");
  assert.equal(failed.requestId, "request-two");
  assert.equal(failed.operation, "cosmos.slots.query");
  assert.equal(failed.error.statusCode, 429);
  assert.ok(failed.durationMs >= 0);
  assert.ok(!errors.join().includes("private diagnostic detail"));
});

test("voice requests log lifecycle, rejected signatures and sanitized failures with correlation IDs", async (t) => {
  const entries: string[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    t.mock.method(console, method, (entry: string) => entries.push(entry));
  }
  const token = "private-twilio-token";
  const speech = "private-caller-speech";
  const config = readConfig({ PUBLIC_BASE_URL: "https://voice.example.com", TWILIO_AUTH_TOKEN: token });
  const server = createApp(config, {
    async handle() {
      return observeOperation("cosmos.patient.read", async () => {
        throw Object.assign(new Error(`${speech}: ${token}`), { code: 403 });
      });
    },
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const body = { CallSid: `CA${"d".repeat(32)}`, SpeechResult: speech };
  const path = "/voice?turn=1";
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(token, `${config.PUBLIC_BASE_URL}${path}`, body),
    },
    body: new URLSearchParams(body),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /could not verify the result/);
  const requestId = response.headers.get("x-request-id");
  const logged = entries.map((entry) => JSON.parse(entry));
  assert.ok(requestId);
  assert.ok(logged.every((entry) => entry.requestId === requestId));
  assert.deepEqual(logged.map((entry) => entry.event), [
    "voice_request_started", "voice_turn_received",
    "dependency_operation_started", "dependency_operation_failed", "voice_request_failed", "voice_request_completed",
  ]);
  assert.equal(logged.find((entry) => entry.event === "voice_request_failed").error.statusCode, 403);
  assert.equal(logged.at(-1).statusCode, 200);
  const rejected = await fetch(`${origin}/voice`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  assert.equal(rejected.status, 403);
  await rejected.text();
  assert.notEqual(rejected.headers.get("x-request-id"), requestId);
  assert.ok(entries.map((entry) => JSON.parse(entry)).some((entry) =>
    entry.event === "voice_request_rejected" && entry.reason === "invalid_signature"));
  const invalidBody = { SpeechResult: speech };
  const invalid = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        token, `${config.PUBLIC_BASE_URL}${path}`, invalidBody,
      ),
    },
    body: new URLSearchParams(invalidBody),
  });
  assert.equal(invalid.status, 400);
  await invalid.text();
  assert.ok(entries.map((entry) => JSON.parse(entry)).some((entry) =>
    entry.event === "voice_request_rejected" && entry.reason === "invalid_payload"));
  for (const sensitive of [speech, token, body.CallSid]) assert.ok(!entries.join().includes(sensitive));
});

test("a model guard rejection speaks an explicit limit message without an automatic retry", async (t) => {
  t.mock.method(console, "log", () => {});
  const errors: string[] = [];
  t.mock.method(console, "error", (entry: string) => errors.push(entry));
  const config = readConfig({
    PUBLIC_BASE_URL: "https://voice.example.com", TWILIO_AUTH_TOKEN: "synthetic-test-token",
  });
  const server = createApp(config, {
    async handle() { throw new ModelUsageLimitError("process"); },
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const body = { CallSid: `CA${"e".repeat(32)}`, SpeechResult: "synthetic speech" };
  const response = await fetch(`http://127.0.0.1:${address.port}/voice`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        config.TWILIO_AUTH_TOKEN, `${config.PUBLIC_BASE_URL}/voice`, body,
      ),
    },
    body: new URLSearchParams(body),
  });
  assert.equal(response.status, 200);
  const xml = await response.text();
  assert.match(xml, /AI request limit was reached or the AI is busy/);
  assert.match(xml, /No new AI request was sent/);
  assert.match(xml, /<Hangup\s*\/>/);
  assert.doesNotMatch(xml, /<Gather/);
  assert.equal(JSON.parse(errors[0] ?? "{}").error.type, "ModelUsageLimitError");
});
