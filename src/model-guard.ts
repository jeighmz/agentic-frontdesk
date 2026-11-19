import { log } from "./logging.ts";

export const MODEL_REQUEST_LIMITS = {
  perProcess: 100,
  perMinute: 10,
  maxOutputTokens: 256,
} as const;

type ModelLimit = "process" | "rate" | "concurrency";

export class ModelUsageLimitError extends Error {
  readonly limit: ModelLimit;

  constructor(limit: ModelLimit) {
    super("The local AI request guard blocked this operation");
    this.name = "ModelUsageLimitError";
    this.limit = limit;
  }
}

export class ModelRequestGuard {
  private requests = 0;
  private recentRequests: number[] = [];
  private active = false;
  private now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const now = this.now();
    this.recentRequests = this.recentRequests.filter((time) => time > now - 60_000);
    let limit: ModelLimit | undefined;
    if (this.requests >= MODEL_REQUEST_LIMITS.perProcess) limit = "process";
    else if (this.active) limit = "concurrency";
    else if (this.recentRequests.length >= MODEL_REQUEST_LIMITS.perMinute) limit = "rate";
    if (limit) {
      log("warn", "llm_request_blocked", {
        limit, requestsUsed: this.requests,
        requestsRemaining: MODEL_REQUEST_LIMITS.perProcess - this.requests,
      });
      throw new ModelUsageLimitError(limit);
    }
    this.requests += 1;
    this.recentRequests.push(now);
    this.active = true;
    try {
      return await work();
    } finally {
      this.active = false;
    }
  }
}

export const modelRequestGuard = new ModelRequestGuard();
