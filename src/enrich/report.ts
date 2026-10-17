import { addUsage, NO_USAGE } from "../domain/enriched-recipe.ts"
import type { ModelName, TokenUsage } from "../domain/enriched-recipe.ts"
import type { EnrichFailure, EnrichReport, FailureKind, RunMode } from "../domain/enrich-report.ts"
import type { RecipeId } from "../domain/recipe.ts"
import { redactKeyLike } from "./llm-types.ts"
import { batchFactor, costUsd, formatUsd, PRICES } from "./pricing.ts"

/** What happened to one recipe that went to the model. */
export type RecipeOutcome =
  | {
      readonly _tag: "Stored"
      readonly id: RecipeId
      readonly usage: TokenUsage
    }
  | {
      readonly _tag: "Failed"
      readonly id: RecipeId
      readonly kind: FailureKind
      readonly message: string
      /** Tokens of the failed answers. The API bills them. */
      readonly usage: TokenUsage
    }

export interface ReportParts {
  readonly generatedAt: string
  readonly model: ModelName
  readonly promptVersion: number
  readonly mode: RunMode
  readonly retryFailed: boolean
  readonly batchId: string | null
  readonly outOfScope: number
  readonly cached: number
  readonly deferred: number
  /** Recipes with a parsed file that cannot be read. */
  readonly unreadable: ReadonlyArray<EnrichFailure>
  readonly outcomes: ReadonlyArray<RecipeOutcome>
}

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000

/** `_report.json` of one run (spec A9, A10). */
export const buildReport = (parts: ReportParts): EnrichReport => {
  const usage = parts.outcomes.reduce((sum, outcome) => addUsage(sum, outcome.usage), NO_USAGE)
  const failedOutcomes = parts.outcomes.flatMap((outcome): ReadonlyArray<EnrichFailure> =>
    outcome._tag === "Failed" ? [{ id: outcome.id, kind: outcome.kind, message: outcome.message }] : []
  )
  // The report is a file on disk. A message that has a key in it (an echo of the API) must not reach it.
  const failures = [...parts.unreadable, ...failedOutcomes]
    .map((failure) => ({ ...failure, message: redactKeyLike(failure.message) }))
    .toSorted((a, b) => a.id - b.id)
  const processed = parts.outcomes.length
  return {
    version: 1,
    generatedAt: parts.generatedAt,
    model: parts.model,
    promptVersion: parts.promptVersion,
    mode: parts.mode,
    retryFailed: parts.retryFailed,
    batchId: parts.batchId,
    totals: {
      selected: parts.cached + parts.deferred + processed,
      outOfScope: parts.outOfScope,
      unreadable: parts.unreadable.length,
      cached: parts.cached,
      deferred: parts.deferred,
      processed,
      succeeded: processed - failedOutcomes.length,
      failed: failures.length,
    },
    failures,
    usage,
    cost: {
      currency: "USD",
      model: parts.model,
      mode: parts.mode,
      pricePerMillionTokens: PRICES[parts.model],
      batchFactor: batchFactor(parts.mode),
      estimatedUsd: round6(costUsd(usage, parts.model, parts.mode)),
    },
  }
}

/** `processed 32, succeeded 31, failed 1, cached 0` */
export const formatTotals = (report: EnrichReport): string => {
  const { totals } = report
  const base = `processed ${totals.processed}, succeeded ${totals.succeeded}, failed ${totals.failed}, cached ${totals.cached}`
  const notes = [
    totals.outOfScope > 0 ? `out of scope ${totals.outOfScope}` : "",
    totals.deferred > 0 ? `not processed because of --limit ${totals.deferred}` : "",
  ].filter((note) => note !== "")
  return notes.length === 0 ? base : `${base}, ${notes.join(", ")}`
}

/** `tokens: input 1000, output 2000, cache read 0, cache write 0; estimated cost 0.1234 USD (sync)` */
export const formatUsage = (report: EnrichReport): string => {
  const { usage, cost } = report
  return (
    `tokens: input ${usage.inputTokens}, output ${usage.outputTokens}, cache read ${usage.cacheReadTokens}, ` +
    `cache write ${usage.cacheCreationTokens}; estimated cost ${formatUsd(cost.estimatedUsd)} USD (${cost.mode}, ${cost.model})`
  )
}
