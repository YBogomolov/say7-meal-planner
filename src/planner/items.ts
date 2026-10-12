import { Schema } from "effect"
import type { Aliases, Catalogue, CatalogueIngredient } from "../domain/catalogue.ts"
import type { RecipeId } from "../domain/recipe.ts"

/** JSON text codec for `config/item-aliases.json`: `{ "<variant>": "<canonical>" }`. */
export const AliasesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

export const NO_ALIASES: Aliases = new Map()

/** Lower case, `ё` to `е`, trimmed, whitespace collapsed to 1 space (spec P4.2.3, without the alias step). */
export const cleanItemName = (text: string): string =>
  text.normalize("NFC").toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ").trim()

/**
 * The alias map for `normaliseItem`. The variants and the canonical names are cleaned with `cleanItemName`,
 * so the file can have capital letters or `ё`. An empty name and a variant that equals its canonical name have no effect.
 * If 2 variants are the same after the cleaning, the later one wins. The map does not follow chains: `a → b` and `b → c` give `a → b`.
 */
export const makeAliases = (record: Readonly<Record<string, string>>): Aliases =>
  new Map(
    Object.entries(record).flatMap(([variant, canonical]): Array<[string, string]> => {
      const from = cleanItemName(variant)
      const to = cleanItemName(canonical)
      return from === "" || to === "" || from === to ? [] : [[from, to]]
    })
  )

/** The name of a product in all of P4 (spec P4.2.3): cleaned, then replaced through the alias map. */
export const normaliseItem = (item: string, aliases: Aliases): string => {
  const cleaned = cleanItemName(item)
  return aliases.get(cleaned) ?? cleaned
}

/** A product that the household buys for the dish: not a staple that is at home, and not optional (spec P4.2.4, P4.4). */
export const isBuyIngredient = (ingredient: Pick<CatalogueIngredient, "pantry" | "optional">): boolean =>
  !ingredient.pantry && !ingredient.optional

/** The normalised names of the products to buy for a dish, sorted, each once. */
export const buyItemsOf = (ingredients: ReadonlyArray<CatalogueIngredient>): ReadonlyArray<string> =>
  [...new Set(ingredients.filter(isBuyIngredient).map((ingredient) => ingredient.item))].sort(compareText)

/** Plain comparison of text. For lower-case Cyrillic without `ё` it is the alphabetical order. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** One normalised item in the report of `npm run items:report`. */
export interface ItemReportRow {
  readonly item: string
  /** Number of recipes of the catalogue that have the item. */
  readonly recipes: number
  /** The names as the enrichment wrote them, before the cleaning and the aliases. Sorted. */
  readonly variants: ReadonlyArray<string>
}

/**
 * Every normalised item with the number of recipes and the raw variants (spec P4.2.5).
 * The rows are sorted by the number of recipes (most first), then by name.
 */
export const itemsReport = (catalogue: Catalogue): ReadonlyArray<ItemReportRow> => {
  const recipesOf = new Map<string, Set<RecipeId>>()
  const variantsOf = new Map<string, Set<string>>()
  for (const entry of catalogue.entries) {
    for (const ingredient of entry.enrichment.ingredients) {
      recipesOf.set(ingredient.item, (recipesOf.get(ingredient.item) ?? new Set()).add(entry.id))
      variantsOf.set(ingredient.item, (variantsOf.get(ingredient.item) ?? new Set()).add(ingredient.rawItem))
    }
  }
  return [...recipesOf.entries()]
    .map(([item, recipes]): ItemReportRow => ({
      item,
      recipes: recipes.size,
      variants: [...(variantsOf.get(item) ?? [])].sort(compareText)
    }))
    .sort((a, b) => b.recipes - a.recipes || compareText(a.item, b.item))
}
