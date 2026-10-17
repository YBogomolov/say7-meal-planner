import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { EnrichedRecipe } from "../src/domain/enriched-recipe.ts"
import type { Enrichment } from "../src/domain/enriched-recipe.ts"
import type { EvalField } from "../src/domain/enrich-eval.ts"
import { GoldEntry } from "../src/domain/gold.ts"
import {
  buildEvalReport,
  formatEvalReport,
  LONG_WAIT_HOURS,
  normaliseName,
  percentOf,
  scoreEntry,
  summariseChecks,
} from "../src/enrich/eval.ts"
import type { EntryInput, StoredEntry } from "../src/enrich/eval.ts"
import { enrichmentFor, id } from "./support/enrich.ts"

/** An invented gold entry. The numbers are not from a page. */
const goldEntry = (changes: Record<string, unknown> = {}): GoldEntry =>
  Schema.decodeUnknownSync(GoldEntry)({
    id: 7,
    title: "Тестовая рыба",
    dishType: ["main"],
    mealFit: ["needs_side", "full_meal"],
    proteinFamilies: ["fish"],
    vegetarian: false,
    heat: { min: 0, max: 1 },
    servings: { min: 6, max: 8, tolerance: 1 },
    activeMinutes: { min: 50, max: 100 },
    longWait: false,
    keyLines: [
      {
        raw: "500 г трески",
        item: ["треска", "рыба"],
        category: ["fish"],
        pantry: false,
      },
      {
        raw: "200 г моркови",
        item: ["морковь"],
        category: ["vegetable"],
        pantry: false,
      },
      {
        raw: "соль",
        item: ["соль"],
        category: ["spice", "other"],
        pantry: true,
      },
    ],
    note: "invented",
    ...changes,
  })

const LINES = ["500 г трески", "200 г моркови", "соль"]

/** An enrichment that passes every check of `goldEntry()`. */
const passing = (): Enrichment => {
  const base = enrichmentFor(3)
  const [first, second, third] = base.ingredients
  if (first === undefined || second === undefined || third === undefined) {
    return assert.fail("enrichmentFor(3) has 3 items")
  }
  return {
    ...base,
    ingredients: [
      { ...first, item: "треска", category: "fish", pantry: false },
      { ...second, item: "морковь", category: "vegetable", pantry: false },
      {
        ...third,
        item: "соль",
        category: "spice",
        pantry: true,
        quantity: null,
        unit: null,
        grams: null,
      },
    ],
    proteinFamilies: ["fish"],
    vegetarian: false,
    dishType: "main",
    mealFit: "needs_side",
    servings: { min: 6, max: 8, source: "estimated" },
    activeMinutes: 60,
    heat: 1,
    longWaitHours: 3,
  }
}

const score = (enrichment: Enrichment | null, gold = goldEntry(), lines: ReadonlyArray<string> | null = LINES) =>
  scoreEntry({
    gold,
    enrichment: Option.fromNullishOr(enrichment),
    lines: Option.fromNullishOr(lines),
  } satisfies EntryInput)

const failedFields = (checks: ReturnType<typeof score>): ReadonlyArray<EvalField> =>
  checks.filter((check) => !check.passed).map((check) => check.field)

describe("scoreEntry", () => {
  it("passes all 17 checks for a matching enrichment", () => {
    const checks = score(passing())
    assert.lengthOf(checks, 8 + 3 * 3)
    assert.deepStrictEqual(failedFields(checks), [])
  })

  it.each<[string, Partial<Enrichment>, EvalField]>([
    ["dishType", { dishType: "soup" }, "dishType"],
    ["mealFit", { mealFit: "side_only" }, "mealFit"],
    ["proteinFamilies with an extra family", { proteinFamilies: ["fish", "pork"] }, "proteinFamilies"],
    ["proteinFamilies with a missing family", { proteinFamilies: [] }, "proteinFamilies"],
    ["proteinFamilies with another family", { proteinFamilies: ["seafood"] }, "proteinFamilies"],
    ["vegetarian", { vegetarian: true }, "vegetarian"],
    ["heat above the range", { heat: 2 }, "heat"],
    ["activeMinutes below the range", { activeMinutes: 49 }, "activeMinutes"],
    ["activeMinutes above the range", { activeMinutes: 101 }, "activeMinutes"],
    ["longWait for a long wait", { longWaitHours: 6 }, "longWait"],
    ["servings min below the range", { servings: { min: 4, max: 8, source: "estimated" } }, "servings"],
    ["servings max above the range", { servings: { min: 6, max: 10, source: "estimated" } }, "servings"],
  ])("fails only %s", (_name, changes, field) => {
    assert.deepStrictEqual(failedFields(score({ ...passing(), ...changes })), [field])
  })

  it("accepts any accepted value of dishType and mealFit", () => {
    const gold = goldEntry({
      dishType: ["main", "side"],
      mealFit: ["full_meal"],
    })
    assert.deepStrictEqual(failedFields(score({ ...passing(), dishType: "side", mealFit: "full_meal" }, gold)), [])
    assert.deepStrictEqual(failedFields(score({ ...passing(), dishType: "salad", mealFit: "needs_side" }, gold)), [
      "dishType",
      "mealFit",
    ])
  })

  it("compares proteinFamilies as a set: the order does not matter", () => {
    const gold = goldEntry({ proteinFamilies: ["fish", "pork"] })
    assert.deepStrictEqual(failedFields(score({ ...passing(), proteinFamilies: ["pork", "fish"] }, gold)), [])
  })

  describe("the ends of the ranges", () => {
    it("include both ends of heat and activeMinutes", () => {
      for (const heat of [0, 1]) {
        assert.deepStrictEqual(failedFields(score({ ...passing(), heat: heat === 0 ? 0 : 1 })), [])
      }
      for (const activeMinutes of [50, 100]) {
        assert.deepStrictEqual(failedFields(score({ ...passing(), activeMinutes })), [])
      }
    })

    it("widen the servings range by the tolerance at both ends", () => {
      const pass = (min: number, max: number, tolerance: number) =>
        !failedFields(
          score(
            { ...passing(), servings: { min, max, source: "estimated" } },
            goldEntry({ servings: { min: 6, max: 8, tolerance } })
          )
        ).includes("servings")
      assert.isTrue(pass(5, 9, 1))
      assert.isFalse(pass(4, 8, 1))
      assert.isFalse(pass(6, 10, 1))
      assert.isTrue(pass(6, 8, 0))
      assert.isFalse(pass(5, 8, 0))
      assert.isFalse(pass(6, 9, 0))
      assert.isTrue(pass(4, 10, 2))
      assert.isFalse(pass(3, 8, 2))
    })

    it("need min and max of the model to be inside the range", () => {
      // min inside and max outside: fail. Both inside: pass.
      const gold = goldEntry({ servings: { min: 4, max: 4, tolerance: 0 } })
      assert.isTrue(
        failedFields(score({ ...passing(), servings: { min: 4, max: 5, source: "page" } }, gold)).includes("servings")
      )
      assert.isFalse(
        failedFields(score({ ...passing(), servings: { min: 4, max: 4, source: "page" } }, gold)).includes("servings")
      )
    })
  })

  describe("longWait", () => {
    it("uses the limit of 6 hours", () => {
      assert.strictEqual(LONG_WAIT_HOURS, 6)
    })

    it("is true at 6 hours and false below, null counts as false", () => {
      const wait = goldEntry({ longWait: true })
      const longWait = (hours: number | null, gold = wait) =>
        !failedFields(score({ ...passing(), longWaitHours: hours }, gold)).includes("longWait")
      assert.isTrue(longWait(6))
      assert.isTrue(longWait(12))
      assert.isFalse(longWait(5.9))
      assert.isFalse(longWait(null))
      const none = goldEntry({ longWait: false })
      assert.isTrue(longWait(null, none))
      assert.isTrue(longWait(5.9, none))
      assert.isFalse(longWait(6, none))
    })
  })

  describe("key lines", () => {
    const keyFailures = (enrichment: Enrichment, lines: ReadonlyArray<string> | null = LINES) =>
      score(enrichment, goldEntry(), lines).filter((check) => check.field.startsWith("keyLine") && !check.passed)

    it("accepts every accepted name of item, and ignores case and the letter ё", () => {
      const named = (item: string): Enrichment => {
        const base = passing()
        return {
          ...base,
          ingredients: base.ingredients.map((entry) => (entry.line === 0 ? { ...entry, item } : entry)),
        }
      }
      assert.deepStrictEqual(keyFailures(named("рыба")), [])
      assert.deepStrictEqual(keyFailures(named("Треска")), [])
      assert.strictEqual(normaliseName("  Свёкла   Красная "), "свекла красная")
      assert.strictEqual(
        keyFailures(named("палтус"))
          .map((check) => check.field)
          .join(),
        "keyLine.item"
      )
    })

    it("fails category and pantry separately", () => {
      const base = passing()
      const changed: Enrichment = {
        ...base,
        ingredients: base.ingredients.map((entry) =>
          entry.line === 2 ? { ...entry, category: "sauce", pantry: false } : entry
        ),
      }
      assert.deepStrictEqual(
        keyFailures(changed).map((check) => check.field),
        ["keyLine.category", "keyLine.pantry"]
      )
      assert.deepStrictEqual(
        keyFailures(changed).map((check) => check.key),
        ["соль", "соль"]
      )
    })

    it("takes the item that matches when a line has 2 items", () => {
      const base = passing()
      const second = base.ingredients[2]
      if (second === undefined) return assert.fail("item expected")
      const two: Enrichment = {
        ...base,
        // The first item of line 2 is wrong, the second is right.
        ingredients: [
          ...base.ingredients.slice(0, 2),
          { ...second, item: "перец", category: "spice", pantry: true },
          second,
        ],
      }
      assert.deepStrictEqual(keyFailures(two), [])
    })

    it("uses the first item of the line for category and pantry when no item matches", () => {
      const base = passing()
      const wrong: Enrichment = {
        ...base,
        ingredients: base.ingredients.map((entry) =>
          entry.line === 1 ? { ...entry, item: "свекла", category: "vegetable" } : entry
        ),
      }
      const failures = keyFailures(wrong)
      assert.deepStrictEqual(
        failures.map((check) => check.field),
        ["keyLine.item"]
      )
      assert.include(failures[0]?.actual, "свекла")
    })

    it("fails the 3 checks of a line that has no item", () => {
      const base = passing()
      const without: Enrichment = {
        ...base,
        ingredients: base.ingredients.filter((entry) => entry.line !== 1),
      }
      assert.deepStrictEqual(
        keyFailures(without).map((check) => check.field),
        ["keyLine.item", "keyLine.category", "keyLine.pantry"]
      )
    })

    it("finds the line by its exact raw text", () => {
      // The numbers follow the order of the parsed lines, not the order of gold.json.
      const shuffled = ["соль", "200 г моркови", "500 г трески"]
      const base = passing()
      const renumbered: Enrichment = {
        ...base,
        ingredients: base.ingredients.map((entry) => ({
          ...entry,
          line: 2 - entry.line,
        })),
      }
      assert.deepStrictEqual(keyFailures(renumbered, shuffled), [])
      assert.lengthOf(keyFailures(base, shuffled), 6)
    })

    it("fails the 3 checks when the raw line is not in the parsed recipe", () => {
      const failures = keyFailures(passing(), ["500 г трески", "200 г моркови", "соль  "])
      assert.lengthOf(failures, 3)
      assert.include(failures[0]?.actual, "line not found")
    })

    it("fails all the key lines when there is no parsed recipe, and keeps the other fields", () => {
      const checks = score(passing(), goldEntry(), null)
      assert.lengthOf(
        checks.filter((check) => !check.passed),
        9
      )
      assert.isTrue(checks.filter((check) => !check.field.startsWith("keyLine")).every((check) => check.passed))
    })
  })

  it("fails all 17 checks when there is no enrichment", () => {
    const checks = score(null)
    assert.lengthOf(checks, 17)
    assert.isTrue(checks.every((check) => !check.passed))
    assert.isTrue(checks.every((check) => check.actual.startsWith("(no enrichment)")))
  })

  it("names the recipe, the expected value and the actual value in a failed check", () => {
    const check = score({ ...passing(), heat: 3 }).find((entry) => !entry.passed)
    assert.deepStrictEqual(check, {
      id: id(7),
      field: "heat",
      key: null,
      passed: false,
      expected: "0..1",
      actual: "3",
    })
  })
})

describe("percentOf and summariseChecks", () => {
  it("rounds to 1 decimal place", () => {
    assert.strictEqual(percentOf(1, 8), 12.5)
    assert.strictEqual(percentOf(1, 3), 33.3)
    assert.strictEqual(percentOf(2, 3), 66.7)
    assert.strictEqual(percentOf(5, 5), 100)
  })

  it("is 0 for no checks", () => {
    assert.strictEqual(percentOf(0, 0), 0)
  })

  it("gives a row for each of the 11 fields and the total over all checks", () => {
    const checks = [...score(passing()), ...score({ ...passing(), heat: 3, dishType: "soup" })]
    const summary = summariseChecks(checks)
    assert.lengthOf(summary.fields, 11)
    assert.deepStrictEqual(
      summary.fields.find((row) => row.field === "heat"),
      { field: "heat", passed: 1, total: 2, percent: 50 }
    )
    assert.deepStrictEqual(
      summary.fields.find((row) => row.field === "keyLine.item"),
      { field: "keyLine.item", passed: 6, total: 6, percent: 100 }
    )
    assert.deepStrictEqual(summary.total, {
      passed: 32,
      total: 34,
      percent: 94.1,
    })
  })
})

describe("buildEvalReport and formatEvalReport", () => {
  const stored = (model: "claude-haiku-5-5" | "claude-sonnet-5-5", enrichment: Enrichment) =>
    Schema.decodeUnknownSync(EnrichedRecipe)({
      id: 7,
      enrichmentVersion: 1,
      model,
      promptVersion: 1,
      inputHash: "a".repeat(64),
      createdAt: "2026-10-12T14:00:00.000Z",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      enrichment,
    })

  const entry = (gold: GoldEntry, file: EnrichedRecipe | null, enrichment: Enrichment | null): StoredEntry => ({
    gold,
    stored: Option.fromNullishOr(file),
    enrichment: Option.fromNullishOr(enrichment),
    lines: Option.some(LINES),
  })

  const report = buildEvalReport(
    [
      entry(goldEntry(), stored("claude-haiku-5-5", { ...passing(), heat: 3 }), { ...passing(), heat: 3 }),
      entry(goldEntry({ id: 8 }), null, null),
    ],
    "2026-10-12T15:00:00.000Z"
  )

  it("counts the entries, the missing recipes and all checks", () => {
    assert.strictEqual(report.entries, 2)
    assert.deepStrictEqual(report.missing, [id(8)])
    assert.deepStrictEqual(report.total, {
      passed: 16,
      total: 34,
      percent: 47.1,
    })
  })

  it("lists the models and prompt versions of the stored files, and adds the usage and the sync cost", () => {
    assert.deepStrictEqual(report.models, ["claude-haiku-5-5"])
    assert.deepStrictEqual(report.promptVersions, [1])
    assert.strictEqual(report.usage.inputTokens, 1_000_000)
    // 1 million input at 0.10 plus 1 million output at 0.50
    assert.closeTo(report.estimatedUsd, 0.6, 1e-9)
  })

  it("lists the models of 2 files once each, in order", () => {
    const both = buildEvalReport(
      [
        entry(goldEntry(), stored("claude-sonnet-5-5", passing()), passing()),
        entry(goldEntry({ id: 8 }), stored("claude-haiku-5-5", passing()), passing()),
      ],
      "2026-10-12T15:00:00.000Z"
    )
    assert.deepStrictEqual(both.models, ["claude-haiku-5-5", "claude-sonnet-5-5"])
  })

  it("prints a table with a row for each field, the total, the missing recipes and the failed checks", () => {
    const text = formatEvalReport(report).join("\n")
    assert.include(text, "TOTAL")
    assert.include(text, "47.1")
    assert.include(text, "no enrichment for: 8")
    assert.include(text, "7 heat: expected 0..1, got 3")
    assert.include(text, "models: claude-haiku-5-5; prompt versions: 1")
    assert.include(text, "estimated cost 0.6000 USD")
    for (const field of [
      "dishType",
      "mealFit",
      "proteinFamilies",
      "vegetarian",
      "activeMinutes",
      "servings",
      "longWait",
      "keyLine.item",
    ]) {
      assert.include(text, field)
    }
  })

  it("prints a short text when every check passes", () => {
    const text = formatEvalReport(
      buildEvalReport(
        [entry(goldEntry(), stored("claude-haiku-5-5", passing()), passing())],
        "2026-10-12T15:00:00.000Z"
      )
    ).join("\n")
    assert.include(text, "all checks passed")
    assert.include(text, "100.0")
  })
})
