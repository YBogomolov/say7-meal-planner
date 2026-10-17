import { Schema } from "effect"
import { PARSER_VERSION, ParseFailureReason, WarningKind } from "./parsed-recipe.ts"
import { IsoTimestamp, RecipeId } from "./recipe.ts"

/** Why a page is in the list of failed pages: a `ParseError` reason, or `unreadable` when the HTML file cannot be read. */
export const FailureReason = Schema.Literals([...ParseFailureReason.literals, "unreadable"])
export type FailureReason = typeof FailureReason.Type

export const FailedPage = Schema.Struct({
  id: RecipeId,
  reason: FailureReason,
  message: Schema.String,
})
export type FailedPage = typeof FailedPage.Type

/**
 * `data/parsed/_report.json` (spec P2, rule 3).
 *
 * - `totals.processed` is the number of pages that the run read. `ok + failed = processed`.
 * - `totals.withWarnings` is the number of parsed pages with at least one warning.
 * - `failed` lists the pages that did not parse, with the reason.
 * - `warningCounts` has one count for each kind of warning (also 0). `warningIds` lists the pages for each kind.
 */
export const ParseReport = Schema.Struct({
  version: Schema.Literal(1),
  parserVersion: Schema.Literal(PARSER_VERSION),
  generatedAt: IsoTimestamp,
  totals: Schema.Struct({
    processed: Schema.Natural,
    ok: Schema.Natural,
    failed: Schema.Natural,
    withWarnings: Schema.Natural,
  }),
  failed: Schema.Array(FailedPage),
  warningCounts: Schema.Record(WarningKind, Schema.Natural),
  warningIds: Schema.Record(WarningKind, Schema.Array(RecipeId)),
})
export type ParseReport = typeof ParseReport.Type

export const ParseReportJson = Schema.fromJsonString(ParseReport, { space: 2 })
