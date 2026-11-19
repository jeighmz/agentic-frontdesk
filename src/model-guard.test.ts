import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRequestGuard, ModelUsageLimitError } from "./model-guard.ts";

test("a rolling minute allows ten requests and blocks the next until the oldest expires", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (entry: string) => warnings.push(entry));
  let now = 0;
  const guard = new ModelRequestGuard(() => now);
  let sent = 0;
  const work = async () => { sent += 1; };
  for (let index = 0; index < 10; index += 1) await guard.run(work);
  await assert.rejects(guard.run(work), (error) => error instanceof ModelUsageLimitError && error.limit === "rate");
  now = 59_999;
  await assert.rejects(guard.run(work), ModelUsageLimitError);
  assert.equal(sent, 10);
  now = 60_000;
  await guard.run(work);
  assert.equal(sent, 11);
  const blocked = JSON.parse(warnings[0] ?? "{}");
  assert.equal(blocked.event, "llm_request_blocked");
  assert.equal(blocked.limit, "rate");
  assert.equal(blocked.requestsUsed, 10);
  assert.equal(blocked.requestsRemaining, 90);
});

test("the hundred-request lifetime allowance counts failures and never refills with time", async (t) => {
  t.mock.method(console, "warn", () => {});
  let now = 0;
  let sent = 0;
  const guard = new ModelRequestGuard(() => now);
  const failure = new Error("Synthetic provider failure");
  for (let index = 0; index < 100; index += 1) {
    now = index * 6_000;
    await assert.rejects(guard.run(async () => { sent += 1; throw failure; }), (error) => error === failure);
  }
  now += 60 * 60_000;
  await assert.rejects(guard.run(async () => { sent += 1; }),
    (error) => error instanceof ModelUsageLimitError && error.limit === "process");
  assert.equal(sent, 100);
});

test("concurrent work is not queued and the lock is released after failure", async (t) => {
  t.mock.method(console, "warn", () => {});
  const guard = new ModelRequestGuard();
  const pending = Promise.withResolvers<void>();
  const first = guard.run(() => pending.promise);
  let sent = 0;
  await assert.rejects(guard.run(async () => { sent += 1; }),
    (error) => error instanceof ModelUsageLimitError && error.limit === "concurrency");
  assert.equal(sent, 0);
  const failure = new Error("Synthetic failure");
  const rejected = assert.rejects(first, (error) => error === failure);
  pending.reject(failure);
  await rejected;
  await guard.run(async () => { sent += 1; });
  assert.equal(sent, 1);
});
