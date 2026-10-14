import { Schema } from "effect"
import { IngredientCategory, IngredientUnit } from "./enriched-recipe.ts"
import { DayIndex, SessionId } from "./household.ts"
import { IsoDate, RecipeId } from "./recipe.ts"
import { CookingSession, PlanScale } from "./week-plan.ts"

/** The order of the departments in the shop (spec P4.5.3). It lists every `IngredientCategory` once. */
export const SHOP_ORDER = [
  "vegetable",
  "herb",
  "fruit",
  "poultry",
  "meat",
  "fish",
  "seafood",
  "dairy",
  "eggs",
  "bakery",
  "grain",
  "pasta",
  "legume",
  "canned",
  "frozen",
  "sauce",
  "nuts",
  "sweet",
  "spice",
  "oil",
  "other"
] as const satisfies ReadonlyArray<IngredientCategory>

/** The categories of raw animal products that the freeze rule covers (spec P4.5.5). */
export const RAW_PROTEIN_CATEGORIES: ReadonlyArray<IngredientCategory> = ["poultry", "meat", "fish", "seafood"]

/** One quantity: grams, millilitres or a count. `value` is rounded: whole numbers for `g` and `ml`, 2 decimals for the rest. */
export const ShoppingAmount = Schema.Struct({
  unit: IngredientUnit,
  value: Schema.Finite
})
export type ShoppingAmount = typeof ShoppingAmount.Type

/**
 * One product of the list.
 *
 * - `amounts` is 1 entry if the lines of the product have grams (the sum in `g`, or in `ml` for liquids).
 *   Otherwise it has 1 sum for each unit. It is empty if no line has a quantity ("соль по вкусу").
 *   The units `tbsp` and `tsp` stay spoons if the product has no line in `ml`: the sum is whole `tbsp` and the rest in `tsp`
 *   (1 `tbsp` is 3 `tsp`). If the product also has a line in `ml`, the spoons turn into `ml` (15 and 5) before the sum.
 * - Eggs, yolks and whites (spec P4.5.7): `amounts` is `[pcs, g]`, the pieces rounded up and the grams of the sum.
 *   A cereal that has only `ml` is converted: 1 amount in `g`, with `approximate`.
 * - `approximate` is true if the units mix, or if a line without quantity could not add to the sum.
 * - `recipeIds` are the dishes that use the product.
 * - `simpleIds` are the simple breakfasts that use the product (spec P7.2.3), sorted.
 *   Their amounts are per portion times the persons of each slot.
 */
export const ShoppingItem = Schema.Struct({
  item: Schema.NonEmptyString,
  category: IngredientCategory,
  amounts: Schema.Array(ShoppingAmount),
  approximate: Schema.Boolean,
  recipeIds: Schema.Array(RecipeId),
  simpleIds: Schema.Array(Schema.String)
})
export type ShoppingItem = typeof ShoppingItem.Type

/** The items of one department, sorted by name. */
export const ShoppingCategory = Schema.Struct({
  category: IngredientCategory,
  items: Schema.Array(ShoppingItem)
})
export type ShoppingCategory = typeof ShoppingCategory.Type

/**
 * The action "заморозить в день покупки, разморозить в холодильнике накануне сессии <id>" (spec P4.5.5)
 * for one raw product that one session uses later than `rawProteinFridgeDays` after the shopping day.
 * `amounts` and `recipeIds` are the part of the session.
 */
export const FreezeAction = Schema.Struct({
  kind: Schema.Literal("freeze"),
  item: Schema.NonEmptyString,
  session: SessionId,
  amounts: Schema.Array(ShoppingAmount),
  recipeIds: Schema.Array(RecipeId),
  text: Schema.NonEmptyString
})
export type FreezeAction = typeof FreezeAction.Type

/**
 * A cooked dish, for the legend of the list. The recipe text is not here (spec D6): title and link only.
 * A fresh dish (spec P7.2.2) has `session: "fresh"`, `sessionDay: null` and the days that it is cooked and eaten in `freshDays`.
 * `scale` of a fresh dish is the factor for one cooking day.
 */
export const ShoppingDish = Schema.Struct({
  recipeId: RecipeId,
  title: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  session: CookingSession,
  sessionDay: Schema.NullOr(DayIndex),
  freshDays: Schema.Array(DayIndex),
  scale: PlanScale
})
export type ShoppingDish = typeof ShoppingDish.Type

/** A simple breakfast of the plan, for the legend of the list (spec P7.2.3). `portions` is the sum of the persons of its slots. */
export const ShoppingSimple = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  portions: Schema.Natural,
  days: Schema.Array(DayIndex)
})
export type ShoppingSimple = typeof ShoppingSimple.Type

/**
 * The shopping list of a plan (spec P4.5).
 *
 * - `buy`: not pantry, not optional; the departments are in `SHOP_ORDER`.
 * - `optional`: not pantry, optional ("по желанию", "для подачи").
 * - `check_at_home`: pantry.
 * - `unknownRecipeIds`: cooked recipes that the catalogue does not have. They add nothing to the list.
 * - `simpleBreakfasts`: the simple breakfasts of the plan. `unknownSimpleIds`: IDs that `config/simple-breakfasts.json` does not have.
 */
export const ShoppingList = Schema.Struct({
  weekStart: IsoDate,
  shoppingDay: DayIndex,
  buy: Schema.Array(ShoppingCategory),
  optional: Schema.Array(ShoppingItem),
  check_at_home: Schema.Array(ShoppingItem),
  actions: Schema.Array(FreezeAction),
  dishes: Schema.Array(ShoppingDish),
  unknownRecipeIds: Schema.Array(RecipeId),
  simpleBreakfasts: Schema.Array(ShoppingSimple),
  unknownSimpleIds: Schema.Array(Schema.String)
})
export type ShoppingList = typeof ShoppingList.Type
