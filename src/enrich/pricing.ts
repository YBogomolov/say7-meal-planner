import type { ModelName, TokenUsage } from "../domain/enriched-recipe.ts"
import type { PriceTable, RunMode } from "../domain/enrich-report.ts"

/**
 * USD per million tokens, October 2026 (spec A10).
 * The spec has no price for cache writes. The API bills a write of the 5 minute cache at 1.25 times the input price.
 */
export const PRICES: Readonly<Record<ModelName, PriceTable>> = {
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheCreation: 2.5,
  },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheCreation: 0.125,
  },
}

/** A batch costs 50 % of the normal price (spec A10). */
export const BATCH_FACTOR = 0.5

export const batchFactor = (mode: RunMode): number => (mode === "batch" ? BATCH_FACTOR : 1)

/** Estimated cost in USD of `usage` for one model. */
export const costUsd = (usage: TokenUsage, model: ModelName, mode: RunMode): number => {
  const price = PRICES[model]
  const total =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheCreationTokens * price.cacheCreation
  return (total / 1_000_000) * batchFactor(mode)
}

/**
 * USD with 4 decimal places, rounded half up on the decimal value.
 * `toFixed` rounds the binary value, so it prints `0.0010` for `0.00105`.
 */
export const formatUsd = (value: number): string => {
  const units = Math.round(Number((value * 10_000).toFixed(6)))
  return (units / 10_000).toFixed(4)
}
