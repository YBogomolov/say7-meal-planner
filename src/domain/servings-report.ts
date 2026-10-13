import { Schema } from "effect"
import { DishType, ServingsSource } from "./enriched-recipe.ts"
import { IsoTimestamp, RecipeId } from "./recipe.ts"

/** Why `servingsAudit` flags a recipe. */
export const SERVINGS_REASONS = ["estimated", "max_above_12", "range_above_3x", "portion_mass_out_of_range"] as const
export const ServingsReason = Schema.Literals(SERVINGS_REASONS)
export type ServingsReason = typeof ServingsReason.Type

/** One flagged recipe of `data/servings-report.json`. */
export const ServingsReportEntry = Schema.Struct({
  id: RecipeId,
  title: Schema.String,
  url: Schema.String,
  dishType: DishType,
  servings: Schema.Struct({ min: Schema.Int, max: Schema.Int, source: ServingsSource }),
  /** Grams (or ml) of the non-optional lines for 1 portion, 1 decimal. `null` if the coverage is too low. */
  portionGrams: Schema.NullOr(Schema.Finite),
  /** Share (0 to 1) of the non-optional lines that have `grams`. `null` if the recipe has no such line. */
  gramsCoverage: Schema.NullOr(Schema.Finite),
  reasons: Schema.Array(ServingsReason),
  /** `true` if `config/servings-overrides.json` set the servings of the recipe. */
  overridden: Schema.Boolean
})
export type ServingsReportEntry = typeof ServingsReportEntry.Type

export const ServingsReport = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: IsoTimestamp,
  /** Number of recipes of the catalogue. */
  recipes: Schema.Natural,
  flagged: Schema.Natural,
  /** Flagged recipes with `dishType` main, soup or salad. */
  flaggedMainSoupSalad: Schema.Natural,
  /** Flagged recipes per reason. A recipe can have several reasons. */
  reasons: Schema.Struct({
    estimated: Schema.Natural,
    max_above_12: Schema.Natural,
    range_above_3x: Schema.Natural,
    portion_mass_out_of_range: Schema.Natural
  }),
  entries: Schema.Array(ServingsReportEntry)
})
export type ServingsReport = typeof ServingsReport.Type

/** JSON text codec for `data/servings-report.json`. */
export const ServingsReportJson = Schema.fromJsonString(ServingsReport, { space: 2 })
