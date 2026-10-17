import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { ParseReport, ParseReportJson } from "../src/domain/parse-report.ts"
import { WARNING_KINDS } from "../src/domain/parsed-recipe.ts"
import type { ParsedRecipe, WarningKind } from "../src/domain/parsed-recipe.ts"
import { RecipeId } from "../src/domain/recipe.ts"
import { parseRecipeWithWarnings } from "../src/parser/parse.ts"
import { buildReport, warningsOf } from "../src/parser/report.ts"
import type { PageResult } from "../src/parser/report.ts"
import { recipePage, step } from "./support/recipe-page.ts"
import type { PageOptions } from "./support/recipe-page.ts"

const id = (n: number): RecipeId => Result.getOrThrow(Schema.decodeUnknownResult(RecipeId)(n))

const outcome = (options: PageOptions = {}) => {
  const result = parseRecipeWithWarnings(recipePage(options), id(77))
  return Result.isSuccess(result) ? result.success : assert.fail(result.failure.message)
}

const recipe = (options: PageOptions = {}): ParsedRecipe => outcome(options).recipe

/** The page has one step with a time, so that the warning no_durations does not hide other results. */
const TIMED = { steps: step(1, "Варить 10 минут.") } satisfies PageOptions

describe("warningsOf", () => {
  it("has no warning for a complete page", () => {
    // The default page has no step with a time, so it has the warning no_durations only.
    assert.deepStrictEqual(outcome().warnings, ["no_durations"])
    assert.deepStrictEqual(outcome(TIMED).warnings, [])
  })

  it("names each kind of missing data", () => {
    const cases: ReadonlyArray<readonly [PageOptions, WarningKind]> = [
      [{ summary: null }, "no_intro"],
      [{ summary: "<p>Салат.</p>" }, "no_servings"],
      [{ summary: "<p>Хватит на много порций.</p>" }, "servings_unparsed"],
      [{ dates: null }, "no_added_date"],
      [{ commentsCount: null }, "no_comments_count"],
      [{ categories: null, breadcrumb: "" }, "no_categories"],
      [{ similar: null }, "no_similar"],
    ]
    for (const [options, kind] of cases) {
      assert.include(outcome({ ...TIMED, ...options }).warnings, kind)
    }
  })

  it("does not report servings_unparsed when there is no sentence at all", () => {
    const warnings = outcome({ summary: "<p>Салат.</p>" }).warnings
    assert.include(warnings, "no_servings")
    assert.notInclude(warnings, "servings_unparsed")
  })

  it("reports categories_from_breadcrumb when the page has no block of categories", () => {
    const warnings = outcome({ ...TIMED, categories: null }).warnings
    assert.deepStrictEqual(warnings, ["categories_from_breadcrumb"])
  })

  it("reports no_categories, and not categories_from_breadcrumb, when the breadcrumb has no category", () => {
    const warnings = outcome({
      ...TIMED,
      categories: null,
      breadcrumb: "",
    }).warnings
    assert.deepStrictEqual(warnings, ["no_categories"])
  })

  it("takes the signal from the argument", () => {
    const complete = recipe(TIMED)
    assert.deepStrictEqual(warningsOf(complete, { categoriesFromBreadcrumb: false }), [])
    assert.deepStrictEqual(warningsOf(complete, { categoriesFromBreadcrumb: true }), ["categories_from_breadcrumb"])
  })

  it("does not warn about a yield in pieces when the intro names portions", () => {
    const warnings = outcome({
      ...TIMED,
      summary: '<p>Хватит на 6 порций. <span class="p-yield">100 штук</span></p>',
    }).warnings
    assert.deepStrictEqual(warnings, [])
  })

  it("reports no_servings for a yield in pieces and no other mention of portions", () => {
    const warnings = outcome({
      ...TIMED,
      summary: '<p>Получается <span class="p-yield">100 штук</span>.</p>',
    }).warnings
    assert.deepStrictEqual(warnings, ["no_servings"])
  })
})

describe("buildReport", () => {
  const parsed = (n: number, ...warnings: ReadonlyArray<WarningKind>): PageResult => ({
    _tag: "Parsed",
    id: id(n),
    warnings,
  })
  const failed = (n: number, reason: "no_steps" | "unreadable"): PageResult => ({
    _tag: "Failed",
    id: id(n),
    reason,
    message: "m",
  })
  const when = "2026-10-12T12:00:00.000Z"

  it("counts pages, failures and pages with warnings", () => {
    const report = buildReport(
      [
        parsed(1),
        parsed(2, "no_servings"),
        parsed(3, "no_servings", "no_durations"),
        failed(4, "no_steps"),
        failed(5, "unreadable"),
      ],
      when
    )
    assert.deepStrictEqual(report.totals, {
      processed: 5,
      ok: 3,
      failed: 2,
      withWarnings: 2,
    })
    assert.deepStrictEqual(
      report.failed.map((page) => [page.id, page.reason]),
      [
        [4, "no_steps"],
        [5, "unreadable"],
      ]
    )
  })

  it("counts each kind of warning, also 0, and lists the pages", () => {
    const report = buildReport([parsed(1, "no_servings"), parsed(2, "no_servings", "no_durations")], when)
    assert.deepStrictEqual(Object.keys(report.warningCounts), [...WARNING_KINDS])
    assert.strictEqual(report.warningCounts.no_servings, 2)
    assert.strictEqual(report.warningCounts.no_durations, 1)
    assert.strictEqual(report.warningCounts.no_intro, 0)
    assert.deepStrictEqual<ReadonlyArray<number>>(report.warningIds.no_servings, [1, 2])
    assert.deepStrictEqual<ReadonlyArray<number>>(report.warningIds.no_durations, [2])
  })

  it("does not count the warnings of a failed page", () => {
    const report = buildReport([failed(4, "no_steps")], when)
    assert.deepStrictEqual(report.totals, {
      processed: 1,
      ok: 0,
      failed: 1,
      withWarnings: 0,
    })
    assert.isTrue(Object.values(report.warningCounts).every((count) => count === 0))
  })

  it("gives a valid empty report for a run without pages", () => {
    const report = buildReport([], when)
    assert.deepStrictEqual(report.totals, {
      processed: 0,
      ok: 0,
      failed: 0,
      withWarnings: 0,
    })
    assert.strictEqual(report.generatedAt, when)
  })

  it("survives the JSON codec", () => {
    const report = buildReport([parsed(1, "no_similar"), failed(2, "no_steps")], when)
    const text = Schema.encodeSync(ParseReportJson)(report)
    assert.deepStrictEqual(Schema.decodeUnknownSync(ParseReportJson)(text), report)
    assert.deepStrictEqual(Schema.decodeUnknownSync(ParseReport)(JSON.parse(text)), report)
  })
})
