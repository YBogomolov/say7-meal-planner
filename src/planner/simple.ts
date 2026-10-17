import { Schema } from "effect"
import type { Aliases } from "../domain/catalogue.ts"
import { SimpleBreakfastRecord } from "../domain/simple-breakfast.ts"
import type { SimpleBreakfast } from "../domain/simple-breakfast.ts"
import { normaliseItem } from "./items.ts"

const hasUniqueIds = Schema.makeFilter<ReadonlyArray<SimpleBreakfastRecord>>(
  (records) =>
    new Set(records.map((record) => record.id)).size === records.length || "Expected each simple breakfast ID once"
)

/** JSON text codec for `config/simple-breakfasts.json` (spec P7.2.3). */
export const SimpleBreakfastsJson = Schema.fromJsonString(
  Schema.Array(SimpleBreakfastRecord).pipe(Schema.check(hasUniqueIds))
)

export const NO_SIMPLE_BREAKFASTS: ReadonlyArray<SimpleBreakfast> = []

/** The simple breakfasts for the catalogue. The item names are cleaned and mapped through the alias map, like the items of the catalogue. */
export const makeSimpleBreakfasts = (
  records: ReadonlyArray<SimpleBreakfastRecord>,
  aliases: Aliases
): ReadonlyArray<SimpleBreakfast> =>
  records.map((record) => ({
    id: record.id,
    title: record.title,
    meals: record.meals,
    items: record.items.map((item) => ({
      ...item,
      item: normaliseItem(item.item, aliases),
    })),
  }))
