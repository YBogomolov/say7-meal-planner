import { Schema } from "effect"
import { IsoTimestamp } from "./recipe.ts"

/** One normalised item: how many recipes use it, and the names as the enrichment wrote them. */
export const ItemsReportRow = Schema.Struct({
  item: Schema.NonEmptyString,
  recipes: Schema.Natural,
  variants: Schema.Array(Schema.String),
})
export type ItemsReportRow = typeof ItemsReportRow.Type

/**
 * `data/items-report.json` (spec P4.2.5). The coordinator reads it to fill `config/item-aliases.json`.
 * `recipes` is the number of recipes of the catalogue. The rows are sorted by `recipes`, most first.
 */
export const ItemsReport = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: IsoTimestamp,
  recipes: Schema.Natural,
  items: Schema.Array(ItemsReportRow),
  /** P7.1. Normalised items of the catalogue without an entry in `config/item-protein.json`, sorted. */
  missingProtein: Schema.Array(Schema.String),
})
export type ItemsReport = typeof ItemsReport.Type

/** JSON text codec for `data/items-report.json`. */
export const ItemsReportJson = Schema.fromJsonString(ItemsReport, { space: 2 })
