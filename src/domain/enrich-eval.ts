import { Schema } from "effect"
import { ModelName, TokenUsage } from "./enriched-recipe.ts"
import { IsoTimestamp, RecipeId } from "./recipe.ts"

/** The fields that the evaluation scores (spec P3.5, rule 2). */
export const EvalField = Schema.Literals([
  "dishType",
  "mealFit",
  "proteinFamilies",
  "vegetarian",
  "heat",
  "activeMinutes",
  "servings",
  "longWait",
  "keyLine.item",
  "keyLine.category",
  "keyLine.pantry"
])
export type EvalField = typeof EvalField.Type

/** One pass or fail. A key line check names the raw line in `key`. */
export const EvalCheck = Schema.Struct({
  id: RecipeId,
  field: EvalField,
  key: Schema.NullOr(Schema.String),
  passed: Schema.Boolean,
  expected: Schema.String,
  actual: Schema.String
})
export type EvalCheck = typeof EvalCheck.Type

export const FieldScore = Schema.Struct({
  field: EvalField,
  passed: Schema.Natural,
  total: Schema.Natural,
  percent: Schema.Finite
})
export type FieldScore = typeof FieldScore.Type

/**
 * `<out-dir>/_eval.json`.
 *
 * - `fields` has one row for each field. `total` is the sum of all checks, so a field with more checks counts more.
 * - `missing` lists the gold recipes without a stored enrichment. All their checks fail.
 * - `usage` and `estimatedUsd` come from the stored files of the gold recipes. The price is the sync price.
 */
export const EvalReport = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: IsoTimestamp,
  models: Schema.Array(ModelName),
  promptVersions: Schema.Array(Schema.Int),
  entries: Schema.Natural,
  missing: Schema.Array(RecipeId),
  fields: Schema.Array(FieldScore),
  total: Schema.Struct({ passed: Schema.Natural, total: Schema.Natural, percent: Schema.Finite }),
  usage: TokenUsage,
  estimatedUsd: Schema.Finite,
  checks: Schema.Array(EvalCheck)
})
export type EvalReport = typeof EvalReport.Type

export const EvalReportJson = Schema.fromJsonString(EvalReport, { space: 2 })
