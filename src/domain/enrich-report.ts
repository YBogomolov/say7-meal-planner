import { Schema } from "effect"
import { ModelName, Sha256Hex, TokenUsage } from "./enriched-recipe.ts"
import { IsoTimestamp, RecipeId } from "./recipe.ts"

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeNumber = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/** `sync`: one request for each recipe. `batch`: the Message Batches API (spec A5). */
export const RunMode = Schema.Literals(["sync", "batch"])
export type RunMode = typeof RunMode.Type

/**
 * Why a recipe has no valid enrichment (spec A9).
 *
 * - `decode`: the answer is not valid JSON, fails the Effect Schema, or points to a line that does not exist.
 * - `max_tokens`, `refusal`: the `stop_reason` of the API.
 * - `stop_reason`: any other `stop_reason` than `end_turn`.
 * - `api_error`: the request failed (sync), or the batch result is an error.
 * - `batch_expired`, `batch_canceled`: the batch did not process the request.
 * - `batch_missing`: the results of the batch have no line for the recipe.
 * - `unreadable`: the file `data/parsed/<id>.json` cannot be read or is not valid.
 */
export const FailureKind = Schema.Literals([
  "decode",
  "max_tokens",
  "refusal",
  "stop_reason",
  "api_error",
  "batch_expired",
  "batch_canceled",
  "batch_missing",
  "unreadable",
])
export type FailureKind = typeof FailureKind.Type

export const EnrichFailure = Schema.Struct({
  id: RecipeId,
  kind: FailureKind,
  message: Schema.String,
})
export type EnrichFailure = typeof EnrichFailure.Type

/** Prices in USD per million tokens (spec A10). */
export const PriceTable = Schema.Struct({
  input: NonNegativeNumber,
  output: NonNegativeNumber,
  cacheRead: NonNegativeNumber,
  cacheCreation: NonNegativeNumber,
})
export type PriceTable = typeof PriceTable.Type

/**
 * `<out-dir>/_report.json` (spec A10, A9).
 *
 * - `totals.selected` are the in-scope recipes that the flags chose: `cached + deferred + processed`.
 *   `cached` have a stored file with the current `inputHash`. `deferred` are left out by `--limit`.
 * - `totals.processed` went to the model. `unreadable` have a parsed file that cannot be read, so the model never saw them.
 *   `failed` counts all failures: `processed = succeeded + failed - unreadable`.
 * - `failures` lists the recipes without a valid enrichment, with the reason. `--retry-failed` reads this list.
 * - `usage` is the sum of all answers of this run, failed attempts and retries included.
 * - `cost.estimatedUsd` is `usage` times the prices of the table, times `batchFactor` in batch mode.
 */
export const EnrichReport = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: IsoTimestamp,
  model: ModelName,
  promptVersion: PositiveInt,
  mode: RunMode,
  retryFailed: Schema.Boolean,
  batchId: Schema.NullOr(Schema.NonEmptyString),
  totals: Schema.Struct({
    selected: Schema.Natural,
    outOfScope: Schema.Natural,
    unreadable: Schema.Natural,
    cached: Schema.Natural,
    deferred: Schema.Natural,
    processed: Schema.Natural,
    succeeded: Schema.Natural,
    failed: Schema.Natural,
  }),
  failures: Schema.Array(EnrichFailure),
  usage: TokenUsage,
  cost: Schema.Struct({
    currency: Schema.Literal("USD"),
    model: ModelName,
    mode: RunMode,
    pricePerMillionTokens: PriceTable,
    batchFactor: NonNegativeNumber,
    estimatedUsd: NonNegativeNumber,
  }),
})
export type EnrichReport = typeof EnrichReport.Type

export const EnrichReportJson = Schema.fromJsonString(EnrichReport, {
  space: 2,
})

/**
 * `<out-dir>/_batch.json`: the batch that this directory waits for (spec A5).
 * A new run reads it and goes on with the polling. The run removes the file when it has stored all results.
 * `recipes` keeps what the run needs to store the results, so the run does not rebuild the inputs.
 */
export const BatchState = Schema.Struct({
  version: Schema.Literal(1),
  batchId: Schema.NonEmptyString,
  model: ModelName,
  promptVersion: PositiveInt,
  createdAt: IsoTimestamp,
  recipes: Schema.Array(
    Schema.Struct({
      id: RecipeId,
      inputHash: Sha256Hex,
      /** Number of ingredient lines, for the check of `ingredients[].line`. */
      lineCount: PositiveInt,
    })
  ).pipe(Schema.check(Schema.isNonEmpty())),
})
export type BatchState = typeof BatchState.Type

export const BatchStateJson = Schema.fromJsonString(BatchState, { space: 2 })
