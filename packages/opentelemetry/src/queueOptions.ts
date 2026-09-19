export interface QueueOptions {
  /** Delay between automatic batch flushes, milliseconds. */
  batchInterval: number
  /** Maximum records per export batch. Positive safe integer. */
  maxBatchSize: number
  /** Maximum active, queued and in-flight records combined. */
  maxQueueSize: number
  /** Separate time budgets for each batch and each flush caller. */
  exportTimeoutMs: number
}

// Native (setInterval/setTimeout) delay upper bound.
const MAX_TIMER_MS = 2147483647

const DEFAULTS: Readonly<QueueOptions> = {
  batchInterval: 3000,
  maxBatchSize: 100,
  maxQueueSize: 1000,
  exportTimeoutMs: 30000,
}

/** Positive safe integer: 1, 2, 3… — no zero, negatives, fractions, NaN/±∞. */
const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Positive finite duration within the native timer range; fractions allowed. */
const isValidDurationMs = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > 0 &&
  value <= MAX_TIMER_MS

const resolveCount = (supplied: unknown, name: keyof QueueOptions): number => {
  if (supplied === undefined) return DEFAULTS[name]
  if (!isPositiveSafeInteger(supplied)) {
    throw new RangeError(`Invalid queue option ${name}: ${String(supplied)}`)
  }
  return supplied
}

const resolveDuration = (
  supplied: unknown,
  name: keyof QueueOptions,
): number => {
  if (supplied === undefined) return DEFAULTS[name]
  if (!isValidDurationMs(supplied)) {
    throw new RangeError(`Invalid queue option ${name}: ${String(supplied)}`)
  }
  return supplied
}

/**
 * Validates caller-supplied queue options against their defaults. Explicit
 * `null` and wrong runtime types are rejected (untyped callers), not silently
 * defaulted; only `undefined` falls back to the default.
 */
export const resolveQueueOptions = (
  input: Partial<QueueOptions> = {},
): QueueOptions => ({
  batchInterval: resolveDuration(input.batchInterval, 'batchInterval'),
  maxBatchSize: resolveCount(input.maxBatchSize, 'maxBatchSize'),
  maxQueueSize: resolveCount(input.maxQueueSize, 'maxQueueSize'),
  exportTimeoutMs: resolveDuration(input.exportTimeoutMs, 'exportTimeoutMs'),
})
