import { Option } from "effect"
import type { EnrichedRecipe, Enrichment } from "../domain/enriched-recipe.ts"
import { addUsage, NO_USAGE } from "../domain/enriched-recipe.ts"
import { EvalField } from "../domain/enrich-eval.ts"
import type { EvalCheck, EvalReport, FieldScore } from "../domain/enrich-eval.ts"
import type { GoldEntry } from "../domain/gold.ts"
import { costUsd, formatUsd } from "./pricing.ts"

/** A wait of this many hours or more is a long wait (spec P3.5, `longWait` in gold.json). */
export const LONG_WAIT_HOURS = 6

/** Lower case, `ё` as `е`, single spaces. Two names are the same if the normal forms are equal. */
export const normaliseName = (text: string): string =>
  text.toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ").trim()

const NO_ENRICHMENT = "(no enrichment)"
const NO_PARSED = "(no parsed recipe)"
const NO_LINE = "(line not found in the parsed recipe)"

const inRange = (value: number, low: number, high: number): boolean => value >= low && value <= high

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((value) => right.has(value))
}

const list = (values: ReadonlyArray<string>): string => (values.length === 0 ? "(none)" : values.join("|"))

const range = (low: number, high: number): string => `${low}..${high}`

export interface EntryInput {
  readonly gold: GoldEntry
  /** The stored enrichment of the recipe, or `None` if the file is absent. */
  readonly enrichment: Option.Option<Enrichment>
  /** The ingredient lines of the parsed recipe, in the order of the numbers, or `None` if there is no parsed file. */
  readonly lines: Option.Option<ReadonlyArray<string>>
}

/**
 * Pass or fail for each field of one gold recipe (spec P3.5, rule 2):
 *
 * - `dishType`, `mealFit`: the value is one of the accepted values.
 * - `proteinFamilies`: the same set as in the gold entry.
 * - `vegetarian`: equal.
 * - `heat`, `activeMinutes`: inside the range, the ends included.
 * - `servings`: the range of the gold entry is wider by `tolerance` at both ends. `min` and `max` of the model must both be inside.
 * - `longWait`: `longWaitHours >= 6` equals the gold value.
 * - key lines: found by the exact `raw` text. The items with `line` equal to its number are the answer.
 *   `item` is one of the accepted names. `category` is one of the accepted values and `pantry` is equal,
 *   both for the item that matched `item`, or for the first item of the line if none matched.
 */
export const scoreEntry = (entry: EntryInput): ReadonlyArray<EvalCheck> => {
  const { gold } = entry
  const check = (
    field: EvalField,
    key: string | null,
    passed: boolean,
    expected: string,
    actual: string
  ): EvalCheck => ({
    id: gold.id,
    field,
    key,
    passed,
    expected,
    actual,
  })

  const enrichment = Option.getOrNull(entry.enrichment)
  const lines = Option.getOrNull(entry.lines)

  const direct: ReadonlyArray<EvalCheck> =
    enrichment === null
      ? (
          [
            "dishType",
            "mealFit",
            "proteinFamilies",
            "vegetarian",
            "heat",
            "activeMinutes",
            "servings",
            "longWait",
          ] as const
        ).map((field) => check(field, null, false, "", NO_ENRICHMENT))
      : [
          check(
            "dishType",
            null,
            gold.dishType.includes(enrichment.dishType),
            list(gold.dishType),
            enrichment.dishType
          ),
          check("mealFit", null, gold.mealFit.includes(enrichment.mealFit), list(gold.mealFit), enrichment.mealFit),
          check(
            "proteinFamilies",
            null,
            sameSet(gold.proteinFamilies, enrichment.proteinFamilies),
            list(gold.proteinFamilies),
            list(enrichment.proteinFamilies)
          ),
          check(
            "vegetarian",
            null,
            gold.vegetarian === enrichment.vegetarian,
            String(gold.vegetarian),
            String(enrichment.vegetarian)
          ),
          check(
            "heat",
            null,
            inRange(enrichment.heat, gold.heat.min, gold.heat.max),
            range(gold.heat.min, gold.heat.max),
            String(enrichment.heat)
          ),
          check(
            "activeMinutes",
            null,
            inRange(enrichment.activeMinutes, gold.activeMinutes.min, gold.activeMinutes.max),
            range(gold.activeMinutes.min, gold.activeMinutes.max),
            String(enrichment.activeMinutes)
          ),
          (() => {
            const low = gold.servings.min - gold.servings.tolerance
            const high = gold.servings.max + gold.servings.tolerance
            return check(
              "servings",
              null,
              inRange(enrichment.servings.min, low, high) && inRange(enrichment.servings.max, low, high),
              range(low, high),
              range(enrichment.servings.min, enrichment.servings.max)
            )
          })(),
          check(
            "longWait",
            null,
            (enrichment.longWaitHours !== null && enrichment.longWaitHours >= LONG_WAIT_HOURS) === gold.longWait,
            String(gold.longWait),
            enrichment.longWaitHours === null ? "null" : String(enrichment.longWaitHours)
          ),
        ]

  const keyChecks = gold.keyLines.flatMap((keyLine): ReadonlyArray<EvalCheck> => {
    const key = keyLine.raw
    const fail = (actual: string): ReadonlyArray<EvalCheck> => [
      check("keyLine.item", key, false, list(keyLine.item), actual),
      check("keyLine.category", key, false, list(keyLine.category), actual),
      check("keyLine.pantry", key, false, String(keyLine.pantry), actual),
    ]
    if (enrichment === null) return fail(NO_ENRICHMENT)
    if (lines === null) return fail(NO_PARSED)
    const number = lines.indexOf(keyLine.raw)
    if (number < 0) return fail(NO_LINE)

    const items = enrichment.ingredients.filter((item) => item.line === number)
    const accepted = new Set(keyLine.item.map(normaliseName))
    const matched = items.find((item) => accepted.has(normaliseName(item.item)))
    const primary = matched ?? items[0]
    if (primary === undefined) return fail("(no item for the line)")
    return [
      check("keyLine.item", key, matched !== undefined, list(keyLine.item), list(items.map((item) => item.item))),
      check(
        "keyLine.category",
        key,
        keyLine.category.includes(primary.category),
        list(keyLine.category),
        primary.category
      ),
      check("keyLine.pantry", key, primary.pantry === keyLine.pantry, String(keyLine.pantry), String(primary.pantry)),
    ]
  })

  return [...direct, ...keyChecks]
}

/** `12.5` for 1 of 8. One decimal place. */
export const percentOf = (passed: number, total: number): number =>
  total === 0 ? 0 : Math.round((1000 * passed) / total) / 10

/** One score for each field and the total over all checks. */
export const summariseChecks = (
  checks: ReadonlyArray<EvalCheck>
): {
  readonly fields: ReadonlyArray<FieldScore>
  readonly total: EvalReport["total"]
} => {
  const fields = EvalField.literals.map((field): FieldScore => {
    const own = checks.filter((entry) => entry.field === field)
    const passed = own.filter((entry) => entry.passed).length
    return {
      field,
      passed,
      total: own.length,
      percent: percentOf(passed, own.length),
    }
  })
  const passed = checks.filter((entry) => entry.passed).length
  return {
    fields,
    total: {
      passed,
      total: checks.length,
      percent: percentOf(passed, checks.length),
    },
  }
}

export interface StoredEntry extends EntryInput {
  /** The stored file, for the meta data and the usage. */
  readonly stored: Option.Option<EnrichedRecipe>
}

/** The report of `npm run enrich:eval` for the gold recipes. */
export const buildEvalReport = (entries: ReadonlyArray<StoredEntry>, generatedAt: string): EvalReport => {
  const checks = entries.flatMap((entry) => scoreEntry(entry))
  const { fields, total } = summariseChecks(checks)
  const files = entries.flatMap((entry) => Option.toArray(entry.stored))
  return {
    version: 1,
    generatedAt,
    models: [...new Set(files.map((file) => file.model))].toSorted(),
    promptVersions: [...new Set(files.map((file) => file.promptVersion))].toSorted((a, b) => a - b),
    entries: entries.length,
    missing: entries.filter((entry) => Option.isNone(entry.enrichment)).map((entry) => entry.gold.id),
    fields,
    total,
    usage: files.reduce((sum, file) => addUsage(sum, file.usage), NO_USAGE),
    estimatedUsd: files.reduce((sum, file) => sum + costUsd(file.usage, file.model, "sync"), 0),
    checks,
  }
}

/** The table of the console: one row for each field, then the total, then the failed checks. */
export const formatEvalReport = (report: EvalReport): ReadonlyArray<string> => {
  const row = (name: string, passed: number, total: number, percent: number): string =>
    `${name.padEnd(18)}${String(passed).padStart(7)}${String(total).padStart(7)}${percent.toFixed(1).padStart(8)}`
  const failed = report.checks.filter((entry) => !entry.passed)
  return [
    `${"field".padEnd(18)}${"passed".padStart(7)}${"total".padStart(7)}${"%".padStart(8)}`,
    ...report.fields.map((score) => row(score.field, score.passed, score.total, score.percent)),
    row("TOTAL", report.total.passed, report.total.total, report.total.percent),
    "",
    ...(report.missing.length > 0 ? [`no enrichment for: ${report.missing.join(", ")}`, ""] : []),
    ...(failed.length === 0
      ? ["all checks passed"]
      : [
          "failed checks:",
          ...failed.map(
            (entry) =>
              `  ${entry.id} ${entry.field}${entry.key === null ? "" : ` [${entry.key}]`}: expected ${entry.expected}, got ${entry.actual}`
          ),
        ]),
    "",
    `models: ${report.models.join(", ") || "-"}; prompt versions: ${report.promptVersions.join(", ") || "-"}`,
    `tokens: input ${report.usage.inputTokens}, output ${report.usage.outputTokens}, ` +
      `cache read ${report.usage.cacheReadTokens}, cache write ${report.usage.cacheCreationTokens}; ` +
      `estimated cost ${formatUsd(report.estimatedUsd)} USD (sync prices)`,
  ]
}
