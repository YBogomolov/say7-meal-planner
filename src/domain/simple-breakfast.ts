import { Schema } from "effect"
import { IngredientCategory } from "./enriched-recipe.ts"

/** The ID of a simple breakfast in a plan: any non-empty text (an unknown ID is the rule `unknown_simple`). */
export const SimpleId = Schema.NonEmptyString

/** The ID in `config/simple-breakfasts.json`: kebab-case, for example `tvorog-yagody`. */
const ConfigSimpleId = SimpleId.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: "Expected a kebab-case ID, for example tvorog-yagody" }))
)

/** One product of a simple breakfast, per portion (spec P7.2.3). */
export const SimpleBreakfastItem = Schema.Struct({
  item: Schema.NonEmptyString,
  grams: Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0))),
  category: IngredientCategory,
  pantry: Schema.Boolean
})
export type SimpleBreakfastItem = typeof SimpleBreakfastItem.Type

/** A simple breakfast: a fixed set of products, no cooking (spec P7.2.3). The amounts are per portion. */
export const SimpleBreakfast = Schema.Struct({
  id: SimpleId,
  title: Schema.NonEmptyString,
  items: Schema.Array(SimpleBreakfastItem).pipe(Schema.check(Schema.isNonEmpty()))
})
export type SimpleBreakfast = typeof SimpleBreakfast.Type

/** A simple breakfast as the file `config/simple-breakfasts.json` has it: the ID must be kebab-case. */
export const SimpleBreakfastRecord = Schema.Struct({
  id: ConfigSimpleId,
  title: Schema.NonEmptyString,
  items: Schema.Array(SimpleBreakfastItem).pipe(Schema.check(Schema.isNonEmpty()))
})
export type SimpleBreakfastRecord = typeof SimpleBreakfastRecord.Type
