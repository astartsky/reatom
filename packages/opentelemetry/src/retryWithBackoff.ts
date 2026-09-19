import { isAbort } from '@reatom/core'

import { calculateBackoff } from './calculateBackoff.ts'
import { parseRetryAfter } from './parseRetryAfter.ts'

export interface RetryWithBackoffInput {
  send: () => Promise<Response>
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<unknown>
  now?: () => number
  /** Absolute batch deadline, shared by all attempts and body cleanup. */
  deadline?: number
  /** The same signal must also be passed to fetch. */
  signal?: AbortSignal
}

export class ExportTimeoutError extends Error {
  constructor() {
    super('OTLP batch export deadline exceeded')
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

const wait = (
  ms: number,
  signal: AbortSignal | undefined,
  sleep: RetryWithBackoffInput['sleep'],
): Promise<void> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const finish = (failed: boolean, error?: unknown) => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failed) reject(error)
      else resolve()
    }
    const abort = () => finish(true, signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    if (sleep) {
      try {
        Promise.resolve(sleep(ms)).then(
          () => finish(false),
          (error) => finish(true, error),
        )
      } catch (error) {
        finish(true, error)
      }
    } else timer = setTimeout(() => finish(false), ms)
  })

/** Retry network failures and throttling, releasing each discarded body first. */
export const retryWithBackoff = async ({
  send,
  maxRetries = 3,
  baseDelayMs = 1000,
  maxDelayMs = 30_000,
  sleep,
  now = Date.now,
  deadline,
  signal,
}: RetryWithBackoffInput): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    if (deadline !== undefined && now() >= deadline)
      throw new ExportTimeoutError()
    let response: Response | undefined
    try {
      response = await send()
    } catch (error) {
      if (
        signal?.aborted ||
        isAbort(error) ||
        !(error instanceof TypeError) ||
        attempt >= maxRetries
      )
        throw error
    }
    if (response && signal?.aborted) {
      await response.body?.cancel()
      signal.throwIfAborted()
    }
    if (
      response &&
      (!RETRYABLE_STATUS.has(response.status) || attempt >= maxRetries)
    ) {
      return response // Ownership of this final body passes to the caller.
    }
    const retryAfter = response
      ? parseRetryAfter(response.headers.get('Retry-After'), now())
      : undefined
    // Cleanup failures are not network-send failures and must not trigger retry.
    if (response) await response.body?.cancel()
    signal?.throwIfAborted()
    const delay =
      retryAfter ?? calculateBackoff(attempt, baseDelayMs, maxDelayMs)
    if (deadline !== undefined && delay >= deadline - now())
      throw new ExportTimeoutError()
    await wait(delay, signal, sleep)
  }
}
