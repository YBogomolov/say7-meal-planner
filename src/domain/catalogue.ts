import type { Enrichment, IngredientItem } from "./enriched-recipe.ts"
import type { RecipeId } from "./recipe.ts"

/** `{ "<variant>": "<canonical>" }` of `config/item-aliases.json`, with cleaned names (see `makeAliases`). */
export type Aliases = ReadonlyMap<string, string>

/**
 * An ingredient item with the normalised name (spec P4.2.3).
 * `item` is the name that all of P4 uses. `rawItem` is the name as the enrichment wrote it.
 */
export interface CatalogueIngredient extends Omit<IngredientItem, "item"> {
  readonly item: string
  readonly rawItem: string
}

/** The full enrichment of a recipe. Only the item names of the ingredients differ from `Enrichment`. */
export interface CatalogueEnrichment extends Omit<Enrichment, "ingredients"> {
  readonly ingredients: ReadonlyArray<CatalogueIngredient>
}

/** A category of the page, for example `{ id: 40, name: "Вторые блюда" }`. */
export interface CatalogueCategory {
  readonly id: number
  readonly name: string
}

/**
 * A recipe of the catalogue (spec P4.2.2).
 * It has no intro and no steps. `getRecipeDetails` reads them from the parsed file when a caller needs them.
 */
export interface CatalogueEntry {
  readonly id: RecipeId
  readonly url: string
  readonly title: string
  /** The first category of the page: the main section of the site. `null` if the page has none. */
  readonly primaryCategory: CatalogueCategory | null
  readonly commentsCount: number | null
  readonly enrichment: CatalogueEnrichment
}

/** The recipes in memory. `entries` are sorted by ID. */
export interface Catalogue {
  readonly entries: ReadonlyArray<CatalogueEntry>
  readonly byId: ReadonlyMap<RecipeId, CatalogueEntry>
  /** The alias map that normalised the item names. Search uses it for the items of a query. */
  readonly aliases: Aliases
  /** The recipes whose servings `config/servings-overrides.json` set. `servings.source` is still the enrichment's. */
  readonly overridden: ReadonlySet<RecipeId>
}
