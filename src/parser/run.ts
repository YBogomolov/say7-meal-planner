import { Console, DateTime, Effect, Option, Result } from "effect"
import type { FailureReason, ParseReport } from "../domain/parse-report.ts"
import { WARNING_KINDS } from "../domain/parsed-recipe.ts"
import type { RecipeId } from "../domain/recipe.ts"
import type { IndexInvalidError, StoreError } from "../scraper/store.ts"
import { parseRecipeWithWarnings } from "./parse.ts"
import { planParse } from "./plan.ts"
import { buildReport } from "./report.ts"
import type { PageResult } from "./report.ts"
import { ParseStore } from "./store.ts"

export type ParseRunError = StoreError | IndexInvalidError

export interface ParseOptions {
  /** Parse only these IDs. `None` means every page with status `ok` in `index.json`. */
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
}

/** `[k/n] <id> ok`, or `[k/n] <id> ok (warnings: …)`, or `[k/n] <id> failed <reason> (<message>)`. */
export const formatPageLine = (line: {
  readonly k: number
  readonly n: number
  readonly result: PageResult
}): string => {
  const { k, n, result } = line
  const prefix = `[${k}/${n}] ${result.id}`
  if (result._tag === "Failed") {
    return `${prefix} failed ${result.reason} (${result.message})`
  }
  return result.warnings.length === 0 ? `${prefix} ok` : `${prefix} ok (warnings: ${result.warnings.join(", ")})`
}

/** `parsed 34, failed 0, with warnings 21` */
export const formatTotals = (report: ParseReport): string =>
  `parsed ${report.totals.ok}, failed ${report.totals.failed}, with warnings ${report.totals.withWarnings}`

/** The kinds of warning that occurred in a run, as `kind count` pairs. */
export const warningSummary = (report: ParseReport): ReadonlyArray<string> =>
  WARNING_KINDS.filter((kind) => report.warningCounts[kind] > 0).map((kind) => `${kind} ${report.warningCounts[kind]}`)

const failedResult = (id: RecipeId, reason: FailureReason, message: string): PageResult => ({
  _tag: "Failed",
  id,
  reason,
  message,
})

/**
 * Read, parse and save one page.
 * A page that cannot be read or parsed is a `Failed` result, not an error of the run.
 * A write error of the store is an error of the run.
 */
const parsePage = (id: RecipeId): Effect.Effect<PageResult, StoreError, ParseStore> =>
  Effect.gen(function* () {
    const store = yield* ParseStore
    const read = yield* Effect.result(store.readPage(id))
    if (Result.isFailure(read)) {
      return failedResult(id, "unreadable", read.failure.message)
    }
    const parsed = parseRecipeWithWarnings(read.success, id)
    if (Result.isFailure(parsed)) {
      // The file of an earlier run must not outlive a parse that fails now.
      yield* store.removeParsed(id)
      return failedResult(id, parsed.failure.reason, parsed.failure.message)
    }
    yield* store.writeParsed(parsed.success.recipe)
    return { _tag: "Parsed", id, warnings: parsed.success.warnings }
  })

/**
 * Parse every page with status `ok` (or the pages in `--ids`) and write `data/parsed/<id>.json` and `_report.json`.
 * Only a problem with the store (no index, a file that cannot be written) stops the run.
 */
export const parseAll = (options: ParseOptions): Effect.Effect<ParseReport, ParseRunError, ParseStore> =>
  Effect.gen(function* () {
    const store = yield* ParseStore
    yield* store.prepare
    const index = yield* store.readIndex

    const plan = planParse(index, options.ids)
    if (plan.unknownIds.length > 0) {
      yield* Console.warn(`warning: IDs not in index.json: ${plan.unknownIds.join(", ")}`)
    }
    if (plan.notOkIds.length > 0) {
      yield* Console.warn(`warning: IDs without a downloaded page (status is not ok): ${plan.notOkIds.join(", ")}`)
    }
    const n = plan.toParse.length
    yield* Console.log(`index.json: ${Object.keys(index.entries).length} entries; ${n} to parse`)

    const results = yield* Effect.forEach(plan.toParse, (id, position) =>
      parsePage(id).pipe(Effect.tap((result) => Console.log(formatPageLine({ k: position + 1, n, result }))))
    )

    const generatedAt = DateTime.formatIso(yield* DateTime.now)
    const report = buildReport(results, generatedAt)
    yield* store.writeReport(report)
    return report
  })
