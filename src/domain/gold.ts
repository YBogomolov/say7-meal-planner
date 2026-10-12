import { Schema } from "effect"
import { DishType, IngredientCategory, MealFit, ProteinFamily } from "./enriched-recipe.ts"
import { RecipeId } from "./recipe.ts"

const Range = Schema.Struct({ min: Schema.Finite, max: Schema.Finite })

const GoldKeyLine = Schema.Struct({
  /** The exact line from `ingredientGroups` of the parsed recipe. It is unique in its recipe. */
  raw: Schema.NonEmptyString,
  /** Accepted values of `item`. */
  item: Schema.Array(Schema.NonEmptyString).pipe(Schema.check(Schema.isNonEmpty())),
  /** Accepted values of `category`. */
  category: Schema.Array(IngredientCategory).pipe(Schema.check(Schema.isNonEmpty())),
  pantry: Schema.Boolean
})
export type GoldKeyLine = typeof GoldKeyLine.Type

/** One recipe of `test/fixtures/gold.json` (spec P3.5, rule 1). A person checked the facts by hand. */
export const GoldEntry = Schema.Struct({
  id: RecipeId,
  title: Schema.NonEmptyString,
  /** Accepted values. */
  dishType: Schema.Array(DishType).pipe(Schema.check(Schema.isNonEmpty())),
  /** Accepted values. */
  mealFit: Schema.Array(MealFit).pipe(Schema.check(Schema.isNonEmpty())),
  /** The exact expected set. */
  proteinFamilies: Schema.Array(ProteinFamily),
  vegetarian: Schema.Boolean,
  heat: Range,
  /** The evaluation widens the range by `tolerance` portions at both ends. */
  servings: Schema.Struct({ min: Schema.Finite, max: Schema.Finite, tolerance: Schema.Natural }),
  activeMinutes: Range,
  /** True if the recipe needs a wait of 6 hours or more. */
  longWait: Schema.Boolean,
  keyLines: Schema.Array(GoldKeyLine).pipe(Schema.check(Schema.isNonEmpty())),
  note: Schema.String
})
export type GoldEntry = typeof GoldEntry.Type

export const GoldJson = Schema.fromJsonString(Schema.Array(GoldEntry).pipe(Schema.check(Schema.isNonEmpty())))
