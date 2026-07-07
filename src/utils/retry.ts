/**
 * retry.ts
 *
 * Small, dependency-free bounded-retry helper.
 *
 * Deliberately NOT a generic "retry anything" utility with jitter strategies,
 * circuit breakers, etc. — this project only needs "retry N times with
 * exponential backoff, but let the caller decide what's worth retrying."
 * The `isRetryable` predicate is what keeps this safe: callers must be
 * explicit about which failures are transient (network/5xx) vs. terminal
 * (auth/4xx/malformed response), per Phase 4/5's error-handling design.
 */
import logger from './logger.js'

export interface RetryOptions {
  retries: number
  baseDelayMs?: number
  isRetryable?: (err: unknown) => boolean
  label?: string
}

export const withRetry = async <T>(
  fn: () => Promise<T>,
  { retries, baseDelayMs = 500, isRetryable = () => true, label = 'operation' }: RetryOptions
): Promise<T> => {
  let lastErr: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const attemptsLeft = retries - attempt
      if (attemptsLeft <= 0 || !isRetryable(err)) {
        throw err
      }
      const delay = baseDelayMs * Math.pow(2, attempt)
      logger.warn(
        `${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${String(err)}`
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  throw lastErr
}

/** Runs an array of task factories with a bounded number in flight at once. */
export const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  let cursor = 0

  const runners = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}

/** Rejects with an error if the wrapped promise doesn't settle in time. */
export const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, label = 'operation'): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}