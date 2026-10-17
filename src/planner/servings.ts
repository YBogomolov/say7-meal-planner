import { Option, Schema } from "effect"
import type { Catalogue, CatalogueEntry } from "../domain/catalogue.ts"
import type { DishType } from "../domain/enriched-recipe.ts"
import { RecipeId } from "../domain/recipe.ts"
import { SERVINGS_REASONS } from "../domain/servings-report.ts"
import type { ServingsReason, ServingsReportEntry } from "../domain/servings-report.ts"

/** Highest `servings.max` that is not flagged. */
export const MAX_SERVINGS = 12
/** Highest ratio `max / min` that is not flagged. */
export const MAX_SERVINGS_RATIO = 3
/** Portion mass (g) outside `[MIN_PORTION_GRAMS, MAX_PORTION_GRAMS]` is flagged. */
export const MIN_PORTION_GRAMS = 150
export const MAX_PORTION_GRAMS = 700
/** The mass check needs `grams` on at least this share of the non-optional lines (as a fraction `NUM / DEN`). */
const MIN_COVERAGE_NUM = 7
const MIN_COVERAGE_DEN = 10

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

const ServingsOverride = Schema.Struct({
  min: PositiveInt,
  max: PositiveInt,
}).pipe(
  Schema.check(
    Schema.makeFilter<{ readonly min: number; readonly max: number }>(
      (range) => range.min <= range.max || "Expected min to be less than or equal to max"
    )
  )
)
export type ServingsOverride = typeof ServingsOverride.Type

const RECIPE_ID_KEY = /^[1-9]\d*$/

/**
 * JSON text codec for `config/servings-overrides.json`: `{ "<id>": { "min": n, "max": n } }`.
 * The keys are checked by a filter on the record, because a record drops a key that fails its key schema.
 */
export const ServingsOverridesJson = Schema.fromJsonString(
  Schema.Record(Schema.String, ServingsOverride).pipe(
    Schema.check(
      Schema.makeFilter<Readonly<Record<string, ServingsOverride>>>((record) => {
        const bad = Object.keys(record).find((key) => !RECIPE_ID_KEY.test(key))
        return bad === undefined || `Expected a recipe ID (a positive integer) as the key, got "${bad}"`
      })
    )
  )
)

/** The overrides by recipe ID. */
export type ServingsOverrides = ReadonlyMap<RecipeId, ServingsOverride>

export const NO_SERVINGS_OVERRIDES: ServingsOverrides = new Map()

/** The override map of a decoded file. */
export const makeServingsOverrides = (record: Readonly<Record<string, ServingsOverride>>): ServingsOverrides =>
  new Map(
    Object.entries(record).flatMap(([key, value]): Array<[RecipeId, ServingsOverride]> =>
      Option.toArray(Schema.decodeUnknownOption(RecipeId)(Number(key))).map((id) => [id, value])
    )
  )

export interface AppliedOverrides {
  readonly entries: ReadonlyArray<CatalogueEntry>
  /** The IDs of the entries whose servings an override set. */
  readonly overridden: ReadonlySet<RecipeId>
  /** Override IDs that are not in the entries. Sorted. */
  readonly unknown: ReadonlyArray<RecipeId>
}

/**
 * Set `servings.min` and `servings.max` of the entries that have an override. The override wins over the enrichment.
 * `servings.source` stays as the enrichment wrote it: the set of overridden IDs is a separate fact of the catalogue.
 */
export const applyServingsOverrides = (
  entries: ReadonlyArray<CatalogueEntry>,
  overrides: ServingsOverrides
): AppliedOverrides => {
  const known = new Set(entries.map((entry) => entry.id))
  return {
    entries: entries.map((entry) => {
      const override = overrides.get(entry.id)
      return override === undefined
        ? entry
        : {
            ...entry,
            enrichment: {
              ...entry.enrichment,
              servings: { ...entry.enrichment.servings, ...override },
            },
          }
    }),
    overridden: new Set(entries.filter((entry) => overrides.has(entry.id)).map((entry) => entry.id)),
    unknown: [...overrides.keys()].filter((id) => !known.has(id)).sort((a, b) => a - b),
  }
}

/** The grams of 1 portion, and the share of non-optional lines with `grams`. */
const portionOf = (entry: CatalogueEntry): { readonly grams: number | null; readonly coverage: number | null } => {
  const lines = entry.enrichment.ingredients.filter((ingredient) => !ingredient.optional)
  if (lines.length === 0) {
    return { grams: null, coverage: null }
  }
  const withGrams = lines.flatMap((ingredient) => (ingredient.grams === null ? [] : [ingredient.grams]))
  const coverage = withGrams.length / lines.length
  const enough = withGrams.length * MIN_COVERAGE_DEN >= lines.length * MIN_COVERAGE_NUM
  const total = withGrams.reduce((sum, grams) => sum + grams, 0)
  return {
    grams: enough ? total / entry.enrichment.servings.max : null,
    coverage,
  }
}

const round1 = (value: number): number => Math.round(value * 10) / 10

/** The flagged dishes come first in this order. */
const DISH_PRIORITY: ReadonlyArray<DishType> = ["main", "soup", "salad"]
const priorityOf = (dishType: DishType): number => {
  const index = DISH_PRIORITY.indexOf(dishType)
  return index === -1 ? DISH_PRIORITY.length : index
}

/**
 * The reason codes of one recipe and its portion facts. Pure.
 * A human wrote an overridden range, so `estimated` does not apply to it. The other checks still do.
 */
export const servingsReasons = (
  entry: CatalogueEntry,
  overridden = false
): {
  readonly reasons: ReadonlyArray<ServingsReason>
  readonly portionGrams: number | null
  readonly gramsCoverage: number | null
} => {
  const { min, max, source } = entry.enrichment.servings
  const portion = portionOf(entry)
  const flags: Readonly<Record<ServingsReason, boolean>> = {
    estimated: !overridden && source === "estimated",
    max_above_12: max > MAX_SERVINGS,
    range_above_3x: max > MAX_SERVINGS_RATIO * min,
    portion_mass_out_of_range:
      portion.grams !== null && (portion.grams < MIN_PORTION_GRAMS || portion.grams > MAX_PORTION_GRAMS),
  }
  return {
    reasons: SERVINGS_REASONS.filter((reason) => flags[reason]),
    portionGrams: portion.grams,
    gramsCoverage: portion.coverage,
  }
}

export interface ServingsAudit {
  /** Number of recipes that the audit looked at. */
  readonly recipes: number
  /** Flagged recipes: main, soup and salad first, then the other dish types, each group by ID. */
  readonly entries: ReadonlyArray<ServingsReportEntry>
  readonly reasons: Readonly<Record<ServingsReason, number>>
  readonly flaggedMainSoupSalad: number
}

/**
 * Find recipes with servings that look wrong (spec P3 `servings`, handoff T2). Pure.
 * The audit looks at the final servings, after the overrides. `overridden` tells which ones an override set.
 */
export const servingsAudit = (catalogue: Catalogue): ServingsAudit => {
  const entries = catalogue.entries
    .flatMap((entry): Array<ServingsReportEntry> => {
      const overridden = catalogue.overridden.has(entry.id)
      const { reasons, portionGrams, gramsCoverage } = servingsReasons(entry, overridden)
      return reasons.length === 0
        ? []
        : [
            {
              id: entry.id,
              title: entry.title,
              url: entry.url,
              dishType: entry.enrichment.dishType,
              servings: entry.enrichment.servings,
              portionGrams: portionGrams === null ? null : round1(portionGrams),
              gramsCoverage: gramsCoverage === null ? null : Math.round(gramsCoverage * 1000) / 1000,
              reasons,
              overridden,
            },
          ]
    })
    .sort((a, b) => priorityOf(a.dishType) - priorityOf(b.dishType) || a.id - b.id)
  const count = (reason: ServingsReason): number => entries.filter((entry) => entry.reasons.includes(reason)).length
  return {
    recipes: catalogue.entries.length,
    entries,
    reasons: {
      estimated: count("estimated"),
      max_above_12: count("max_above_12"),
      range_above_3x: count("range_above_3x"),
      portion_mass_out_of_range: count("portion_mass_out_of_range"),
    },
    flaggedMainSoupSalad: entries.filter((entry) => priorityOf(entry.dishType) < DISH_PRIORITY.length).length,
  }
}
