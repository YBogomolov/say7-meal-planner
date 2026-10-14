import { Schema } from "effect"
import type { Catalogue, CatalogueEntry, ProteinTable } from "../domain/catalogue.ts"
import { DishType, Equipment, MealFit, ProteinFamily } from "../domain/enriched-recipe.ts"
import type { Reheats } from "../domain/enriched-recipe.ts"
import { MealName } from "../domain/household.ts"
import { RecipeId } from "../domain/recipe.ts"
import { buyItemsOf, cleanItemName, normaliseItem } from "./items.ts"
import { NO_PROTEIN, portionProtein } from "./protein.ts"

export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

/** A word of 4 letters or more matches a word that starts with the same 4 letters or more (spec P4.2.4). */
const MIN_PREFIX = 4

const NonNegativeNumber = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/**
 * The filters and the sort of `searchRecipes` (spec P4.2.4). Every key is optional.
 *
 * - `text`: every word must match. A word of 4 letters or more matches by a common prefix of 4 letters or more
 *   (so `курица` finds `куриное филе`). A shorter word must equal a word of the title or of an item.
 * - `includesItems`: the recipe has every one of these items (names are normalised like the items of the catalogue).
 * - `requiresOnly`: the equipment of the recipe is a subset of this list.
 * - `proteinFamilies`, `dishTypes`, `mealFits`: any of the values. An empty list sets no filter.
 * - `forMeal` (spec P7.2.4): `breakfast` finds the breakfast candidates (`breakfastEligible`, also the `not_a_meal` ones).
 *   `lunch` and `dinner` find the recipes for those meals: no `not_a_meal` recipe.
 *   Without `forMeal`, `not_a_meal` recipes are left out, unless `mealFits` names `not_a_meal`.
 */
export const SearchQuery = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  proteinFamilies: Schema.optionalKey(Schema.Array(ProteinFamily)),
  vegetarian: Schema.optionalKey(Schema.Boolean),
  dishTypes: Schema.optionalKey(Schema.Array(DishType)),
  mealFits: Schema.optionalKey(Schema.Array(MealFit)),
  forMeal: Schema.optionalKey(MealName),
  maxActiveMinutes: Schema.optionalKey(NonNegativeNumber),
  maxTotalMinutes: Schema.optionalKey(NonNegativeNumber),
  maxHeat: Schema.optionalKey(Schema.Literals([0, 1, 2, 3])),
  maxDifficulty: Schema.optionalKey(Schema.Literals([1, 2, 3])),
  requiresOnly: Schema.optionalKey(Schema.Array(Equipment)),
  includesItems: Schema.optionalKey(Schema.Array(Schema.String)),
  excludeIds: Schema.optionalKey(Schema.Array(RecipeId)),
  /** `popular`: most comments first (default). `fewest_items`: fewest items to buy first. */
  sort: Schema.optionalKey(Schema.Literals(["popular", "fewest_items"])),
  /** Default 20, at most 100. */
  limit: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT }))))
})
export type SearchQuery = typeof SearchQuery.Type

/** A compact row of the result (spec P4.2.4). No texts of the recipe. */
export interface SearchRow {
  readonly id: RecipeId
  readonly title: string
  readonly url: string
  readonly dishType: DishType
  readonly mealFit: MealFit
  readonly proteinFamilies: ReadonlyArray<ProteinFamily>
  readonly vegetarian: boolean
  readonly servings: { readonly min: number; readonly max: number }
  readonly activeMinutes: number
  readonly totalMinutes: number
  readonly longWaitHours: number | null
  readonly heat: 0 | 1 | 2 | 3
  readonly difficulty: 1 | 2 | 3
  readonly fridgeDays: number
  readonly freezable: boolean
  readonly reheats: Reheats
  readonly sideHint: string | null
  /** The normalised items that are not pantry and not optional, sorted. */
  readonly buyItems: ReadonlyArray<string>
  readonly commentsCount: number | null
  /** True if the recipe is a breakfast candidate (spec P7.2.4). */
  readonly breakfastEligible: boolean
  /** Grams of protein per portion, 1 decimal (spec P7.1.6). 0 if the protein table is empty. */
  readonly proteinPerPortion: number
}

export const toSearchRow = (entry: CatalogueEntry, proteinTable: ProteinTable = NO_PROTEIN): SearchRow => {
  const { enrichment } = entry
  return {
    id: entry.id,
    title: entry.title,
    url: entry.url,
    dishType: enrichment.dishType,
    mealFit: enrichment.mealFit,
    proteinFamilies: enrichment.proteinFamilies,
    vegetarian: enrichment.vegetarian,
    servings: { min: enrichment.servings.min, max: enrichment.servings.max },
    activeMinutes: enrichment.activeMinutes,
    totalMinutes: enrichment.totalMinutes,
    longWaitHours: enrichment.longWaitHours,
    heat: enrichment.heat,
    difficulty: enrichment.difficulty,
    fridgeDays: enrichment.fridgeDays,
    freezable: enrichment.freezable,
    reheats: enrichment.reheats,
    sideHint: enrichment.sideHint,
    buyItems: buyItemsOf(enrichment.ingredients),
    commentsCount: entry.commentsCount,
    breakfastEligible: entry.breakfastEligible,
    proteinPerPortion: portionProtein(entry, proteinTable).grams
  }
}

const WORD = /[\p{L}\p{N}]+/gu

/** The words of a text: lower case, `ё` to `е`. */
const wordsOf = (text: string): ReadonlyArray<string> => cleanItemName(text).match(WORD) ?? []

const commonPrefixLength = (a: string, b: string): number => {
  let length = 0
  while (length < a.length && length < b.length && a[length] === b[length]) {
    length += 1
  }
  return length
}

const wordMatches = (queryWord: string, target: string): boolean =>
  queryWord.length >= MIN_PREFIX ? commonPrefixLength(queryWord, target) >= MIN_PREFIX : queryWord === target

const matchesText = (entry: CatalogueEntry, queryWords: ReadonlyArray<string>): boolean => {
  if (queryWords.length === 0) {
    return true
  }
  const targets = [...wordsOf(entry.title), ...entry.enrichment.ingredients.flatMap((ingredient) => wordsOf(ingredient.item))]
  return queryWords.every((queryWord) => targets.some((target) => wordMatches(queryWord, target)))
}

/** An absent list, and an empty list, set no filter. Otherwise the value must be in the list. */
const isOneOf = <A>(list: ReadonlyArray<A> | undefined, value: A): boolean =>
  list === undefined || list.length === 0 || list.includes(value)

const compareBy = (sort: "popular" | "fewest_items") => (a: SearchRow, b: SearchRow): number => {
  const popular = (b.commentsCount ?? 0) - (a.commentsCount ?? 0) || a.id - b.id
  return sort === "popular" ? popular : a.buyItems.length - b.buyItems.length || popular
}

/**
 * Filter and sort the catalogue (spec P4.2.4). Pure.
 * The result is at most `limit` rows (default 20, at most 100; a value outside 1 to 100 is moved into the range).
 */
export const searchRecipes = (catalogue: Catalogue, query: SearchQuery): ReadonlyArray<SearchRow> => {
  const queryWords = wordsOf(query.text ?? "")
  const wantedItems = (query.includesItems ?? []).map((item) => normaliseItem(item, catalogue.aliases))
  const excluded = new Set(query.excludeIds ?? [])
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)

  const { proteinFamilies, dishTypes, mealFits, requiresOnly, forMeal } = query
  const fitsMeal = (entry: CatalogueEntry): boolean => {
    if (forMeal === "breakfast") {
      return entry.breakfastEligible
    }
    return entry.enrichment.mealFit !== "not_a_meal" || (forMeal === undefined && mealFits?.includes("not_a_meal") === true)
  }
  const matches = (entry: CatalogueEntry): boolean => {
    const { enrichment } = entry
    return !excluded.has(entry.id) &&
      fitsMeal(entry) &&
      (proteinFamilies === undefined || proteinFamilies.length === 0 ||
        enrichment.proteinFamilies.some((family) => proteinFamilies.includes(family))) &&
      (query.vegetarian === undefined || enrichment.vegetarian === query.vegetarian) &&
      isOneOf(dishTypes, enrichment.dishType) &&
      isOneOf(mealFits, enrichment.mealFit) &&
      (query.maxActiveMinutes === undefined || enrichment.activeMinutes <= query.maxActiveMinutes) &&
      (query.maxTotalMinutes === undefined || enrichment.totalMinutes <= query.maxTotalMinutes) &&
      (query.maxHeat === undefined || enrichment.heat <= query.maxHeat) &&
      (query.maxDifficulty === undefined || enrichment.difficulty <= query.maxDifficulty) &&
      (requiresOnly === undefined || enrichment.equipment.every((item) => requiresOnly.includes(item))) &&
      wantedItems.every((wanted) => enrichment.ingredients.some((ingredient) => ingredient.item === wanted)) &&
      matchesText(entry, queryWords)
  }

  return catalogue.entries.filter(matches).map((entry) => toSearchRow(entry, catalogue.proteinTable)).sort(compareBy(query.sort ?? "popular")).slice(0, limit)
}
