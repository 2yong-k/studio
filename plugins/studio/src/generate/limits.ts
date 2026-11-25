// Do not raise these lightly: a higher limit leaves the spend as it is and only delays the call on an unconfirmed attempt.
export const WAIT_LIMIT_MS = { image: 5 * 60_000, video: 20 * 60_000 } as const;
export const DOWNLOAD_LIMIT_BYTES = { image: 50 * 1024 ** 2, video: 1024 ** 3 } as const;
export const DURATION_TOLERANCE_MS = 250;

// A failed request counts at its price. 5xx failures are never billed, but a rejected input (422) "may still be
// charged" once a runner spent GPU time (https://fal.ai/docs/documentation/model-apis/faq.md,
// https://fal.ai/docs/documentation/model-apis/inference/reliability.md), and the queue reports every failure the
// same way, COMPLETED with `error` (https://fal.ai/docs/api-reference/inference-api/queue/status.md), so a billed one
// cannot be told apart. Over-reading spend is safe; assuming it free could let retries pass the cap.
export const FAILED_REQUEST_BILLED = true;
