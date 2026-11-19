import type { Reply } from "./domain.ts";
import { ModelUsageLimitError } from "./model-guard.ts";

export function voiceFailureReply(error: unknown): Reply {
  return {
    message: error instanceof ModelUsageLimitError
      ? "The demo AI request limit was reached or the AI is busy. No new AI request was sent. Please contact staff for help."
      : "I could not verify the result of that request. Please ask staff to check the schedule before trying again.",
    transfer: true,
    end: false,
  };
}
