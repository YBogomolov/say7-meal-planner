import { Schema } from "effect"
import type { Aliases, Catalogue, CatalogueEntry, ProteinTable } from "../domain/catalogue.ts"
import type { IngredientCategory } from "../domain/enriched-recipe.ts"
import { cleanItemName, compareText, normaliseItem } from "./items.ts"

/** JSON text codec for `config/item-protein.json`: `{ "<item>": <g protein per 100 g> }` (spec P7.1.1). */
export const ItemProteinJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))))
)

export const NO_PROTEIN: ProteinTable = new Map()

/**
 * The protein table for `portionProtein`. The names are cleaned and mapped through the alias map, like the items of the catalogue.
 * An empty name has no effect. If 2 names are the same after the cleaning, the later one wins.
 */
export const makeProteinTable = (record: Readonly<Record<string, number>>, aliases: Aliases): ProteinTable =>
  new Map(
    Object.entries(record).flatMap(([item, grams]): Array<[string, number]> =>
      cleanItemName(item) === "" ? [] : [[normaliseItem(item, aliases), grams]]
    )
  )

/** Categories whose lines count as protein sources, even without a table entry (spec P7.1.2). */
const PROTEIN_CATEGORIES: ReadonlySet<IngredientCategory> = new Set<IngredientCategory>([
  "poultry",
  "meat",
  "fish",
  "seafood",
  "dairy",
  "eggs",
  "legume",
  "nuts"
])

/** Categories whose lines are never protein-relevant, even with a high table value (spec P7.1.2). */
const NEVER_RELEVANT_CATEGORIES: ReadonlySet<IngredientCategory> = new Set<IngredientCategory>(["spice", "herb", "oil"])

/** A table value from this many grams per 100 g makes the line protein-relevant. */
const RELEVANT_PROTEIN_PER_100G = 5

/** Below this coverage the estimate of a dish is uncertain. */
export const UNCERTAIN_COVERAGE = 0.7

export interface PortionProtein {
  /** Grams of protein per portion, 1 decimal. */
  readonly grams: number
  /** Share (0 to 1) of the protein-relevant lines that have grams and a table entry. 1 if the dish has no such line. */
  readonly coverage: number
}

const round1 = (value: number): number => Math.round(value * 10) / 10

/**
 * Protein per portion of a recipe (spec P7.1.2). Pure.
 * Sum of `grams × protein / 100` over the non-optional lines (pantry included), divided by the middle of `servings`.
 * A line without grams or without a table entry adds 0.
 */
export const portionProtein = (entry: CatalogueEntry, table: ProteinTable): PortionProtein => {
  const lines = entry.enrichment.ingredients.filter((ingredient) => !ingredient.optional)
  const { min, max } = entry.enrichment.servings
  const portions = (min + max) / 2
  let total = 0
  let relevant = 0
  let covered = 0
  for (const line of lines) {
    const per100 = table.get(line.item)
    const isRelevant = !NEVER_RELEVANT_CATEGORIES.has(line.category) &&
      (PROTEIN_CATEGORIES.has(line.category) || (per100 !== undefined && per100 >= RELEVANT_PROTEIN_PER_100G))
    if (isRelevant) {
      relevant += 1
    }
    if (per100 !== undefined && line.grams !== null) {
      total += (line.grams * per100) / 100
      if (isRelevant) {
        covered += 1
      }
    }
  }
  return {
    grams: portions > 0 ? round1(total / portions) : 0,
    coverage: relevant === 0 ? 1 : covered / relevant
  }
}

/** The protein of a recipe with the table of the catalogue. */
export const catalogueProtein = (catalogue: Catalogue, entry: CatalogueEntry): PortionProtein =>
  portionProtein(entry, catalogue.proteinTable)

/** The normalised items of the catalogue that the table does not have, sorted (spec P7.1.7). */
export const missingProteinItems = (catalogue: Catalogue): ReadonlyArray<string> =>
  [
    ...new Set(
      catalogue.entries.flatMap((entry) => entry.enrichment.ingredients.map((ingredient) => ingredient.item))
    )
  ]
    .filter((item) => !catalogue.proteinTable.has(item))
    .sort(compareText)
