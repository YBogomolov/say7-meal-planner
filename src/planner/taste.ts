import type { Aliases, CatalogueIngredient } from "../domain/catalogue.ts"
import type { Preferences } from "../domain/household.ts"
import { isBuyIngredient, normaliseItem } from "./items.ts"

/** A side group with its normalised item names. */
export interface SideGroup {
  readonly name: string
  readonly items: ReadonlySet<string>
}

/** A limit with its normalised item names. */
export interface NormalisedLimit {
  readonly name: string
  readonly items: ReadonlySet<string>
  readonly maxDishes: number
}

/** `household.preferences` with the item names cleaned and mapped through the alias map (spec P4.8). */
export interface TasteRules {
  readonly excludedDishTypes: Preferences["excludedDishTypes"]
  readonly sideGroups: ReadonlyArray<SideGroup>
  readonly sideMinGrams: number
  readonly dinnerAvoidSideGroups: ReadonlySet<string>
  readonly dinnerAvoidItems: ReadonlySet<string>
  readonly itemLimits: ReadonlyArray<NormalisedLimit>
}

const normalisedSet = (items: ReadonlyArray<string>, aliases: Aliases): ReadonlySet<string> =>
  new Set(items.map((item) => normaliseItem(item, aliases)))

export const tasteRulesOf = (preferences: Preferences, aliases: Aliases): TasteRules => ({
  excludedDishTypes: preferences.excludedDishTypes,
  sideGroups: Object.entries(preferences.sideGroups).map(([name, items]) => ({ name, items: normalisedSet(items, aliases) })),
  sideMinGrams: preferences.sideMinGrams,
  dinnerAvoidSideGroups: new Set(preferences.dinnerAvoidSideGroups),
  dinnerAvoidItems: normalisedSet(preferences.dinnerAvoidItems, aliases),
  itemLimits: preferences.itemLimits.map((limit) => ({
    name: limit.name,
    items: normalisedSet(limit.items, aliases),
    maxDishes: limit.maxDishes
  }))
})

/**
 * The side groups of a dish, in the order of the config. A buy-ingredient of a group gives the group to the dish
 * if its grams at scale 1 are at least `sideMinGrams`, or if the grams are unknown.
 */
export const sideGroupsOf = (ingredients: ReadonlyArray<CatalogueIngredient>, rules: TasteRules): ReadonlyArray<string> => {
  const buy = ingredients.filter(isBuyIngredient)
  return rules.sideGroups
    .filter((group) =>
      buy.some((ingredient) =>
        group.items.has(ingredient.item) && (ingredient.grams === null || ingredient.grams >= rules.sideMinGrams)
      )
    )
    .map((group) => group.name)
}

/** The buy-ingredients of a dish that are in `items`, as distinct item names. */
export const buyItemsIn = (ingredients: ReadonlyArray<Pick<CatalogueIngredient, "item" | "pantry" | "optional">>, items: ReadonlySet<string>): ReadonlyArray<string> =>
  [...new Set(ingredients.filter(isBuyIngredient).map((ingredient) => ingredient.item).filter((item) => items.has(item)))]

/** Does the dish have any of the items as a buy-ingredient? */
export const hasAnyBuyItem = (ingredients: ReadonlyArray<Pick<CatalogueIngredient, "item" | "pantry" | "optional">>, items: ReadonlySet<string>): boolean =>
  buyItemsIn(ingredients, items).length > 0
