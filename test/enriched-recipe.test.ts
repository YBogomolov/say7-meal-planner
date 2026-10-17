import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import {
  checkLineCoverage,
  checkLineRange,
  EnrichedRecipe,
  EnrichedRecipeJson,
  Enrichment,
  EnrichmentJson,
  IngredientItem,
  MAX_FRIDGE_DAYS,
} from "../src/domain/enriched-recipe.ts"
import { enrichmentFor } from "./support/enrich.ts"

const accepts = (value: unknown): boolean => Result.isSuccess(Schema.decodeUnknownResult(Enrichment)(value))

const valid = enrichmentFor(2)

/** `valid` with one field replaced. */
const with_ = (changes: Record<string, unknown>): unknown => ({
  ...valid,
  ...changes,
})

describe("Enrichment", () => {
  it("accepts a complete value and keeps it through the JSON codec", () => {
    assert.isTrue(accepts(valid))
    const text = Schema.encodeSync(EnrichmentJson)(valid)
    assert.deepStrictEqual(Schema.decodeUnknownSync(EnrichmentJson)(text), valid)
  })

  it.each([
    ["heat 4", { heat: 4 }],
    ["heat -1", { heat: -1 }],
    ["heat 1.5", { heat: 1.5 }],
    ["difficulty 0", { difficulty: 0 }],
    ["difficulty 4", { difficulty: 4 }],
    ["negative activeMinutes", { activeMinutes: -1 }],
    ["fractional totalMinutes", { totalMinutes: 10.5 }],
    ["negative longWaitHours", { longWaitHours: -2 }],
    ["fridgeDays 5", { fridgeDays: MAX_FRIDGE_DAYS + 1 }],
    ["fridgeDays -1", { fridgeDays: -1 }],
    ["servings min above max", { servings: { min: 6, max: 4, source: "page" } }],
    ["servings 0", { servings: { min: 0, max: 4, source: "page" } }],
    ["servings source unknown", { servings: { min: 4, max: 4, source: "guess" } }],
    ["unknown dishType", { dishType: "dessert" }],
    ["unknown equipment", { equipment: ["hob", "wok"] }],
    ["unknown protein family", { proteinFamilies: ["goat"] }],
    ["missing field", { reheats: undefined }],
  ])("rejects %s", (_name, changes) => {
    assert.isFalse(accepts(with_(changes)))
  })

  it("accepts the ends of the ranges", () => {
    assert.isTrue(
      accepts(
        with_({
          heat: 0,
          difficulty: 1,
          fridgeDays: 0,
          activeMinutes: 0,
          longWaitHours: 0,
        })
      )
    )
    assert.isTrue(
      accepts(
        with_({
          heat: 3,
          difficulty: 3,
          fridgeDays: MAX_FRIDGE_DAYS,
          longWaitHours: 12.5,
        })
      )
    )
    assert.isTrue(accepts(with_({ servings: { min: 4, max: 4, source: "estimated" } })))
  })

  it("accepts null for sideHint and longWaitHours", () => {
    assert.isTrue(accepts(with_({ sideHint: null, longWaitHours: null })))
    assert.isTrue(accepts(with_({ sideHint: "рис", longWaitHours: 8 })))
    assert.isFalse(accepts(with_({ sideHint: "" })))
  })
})

describe("IngredientItem", () => {
  const item = valid.ingredients[0]

  it("accepts null for detail, quantity, unit and grams", () => {
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(IngredientItem)({
          ...item,
          detail: null,
          quantity: null,
          unit: null,
          grams: null,
        })
      )
    )
  })

  it.each([
    ["negative line", { line: -1 }],
    ["fractional line", { line: 0.5 }],
    ["empty item", { item: "" }],
    ["negative quantity", { quantity: -1 }],
    ["negative grams", { grams: -5 }],
    ["unknown unit", { unit: "kg" }],
    ["unknown category", { category: "drink" }],
    ["empty detail", { detail: "" }],
  ])("rejects %s", (_name, changes) => {
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(IngredientItem)({ ...item, ...changes })))
  })
})

describe("checkLineRange", () => {
  it("accepts lines 0 to n-1", () => {
    assert.deepStrictEqual(checkLineRange(enrichmentFor(3), 3), [])
  })

  it("accepts several items for one line", () => {
    const base = enrichmentFor(2)
    const first = base.ingredients[0]
    const twice = {
      ...base,
      ingredients: first === undefined ? [] : [first, first, ...base.ingredients.slice(1)],
    }
    assert.deepStrictEqual(checkLineRange(twice, 2), [])
  })

  it("names every item that points outside the recipe", () => {
    const problems = checkLineRange(enrichmentFor(5), 3)
    assert.deepStrictEqual(problems, [
      "ingredients[3].line is 3, but the recipe has the lines 0 to 2",
      "ingredients[4].line is 4, but the recipe has the lines 0 to 2",
    ])
  })
})

describe("checkLineCoverage (spec P3.4: one item per raw line)", () => {
  it("accepts an item for each line", () => {
    assert.deepStrictEqual(checkLineCoverage(enrichmentFor(3), 3), [])
  })

  it("accepts several items for one line", () => {
    const base = enrichmentFor(2)
    const first = base.ingredients[0]
    const twice = {
      ...base,
      ingredients: first === undefined ? [] : [first, first, ...base.ingredients.slice(1)],
    }
    assert.deepStrictEqual(checkLineCoverage(twice, 2), [])
  })

  it("names every line without an item", () => {
    const base = enrichmentFor(5)
    const gaps = {
      ...base,
      ingredients: base.ingredients.filter((item) => item.line !== 1 && item.line !== 3),
    }
    assert.deepStrictEqual(checkLineCoverage(gaps, 5), [
      "ingredients has no item for the lines 1, 3; every line of the recipe needs at least 1 item",
    ])
  })

  it("names all lines when the list is empty", () => {
    assert.deepStrictEqual(checkLineCoverage({ ...enrichmentFor(2), ingredients: [] }, 2), [
      "ingredients has no item for the lines 0, 1; every line of the recipe needs at least 1 item",
    ])
  })

  it("does not count a line that the recipe does not have", () => {
    assert.strictEqual(checkLineCoverage(enrichmentFor(4), 2).length, 0)
  })
})

describe("EnrichedRecipe", () => {
  const stored = {
    id: 77,
    enrichmentVersion: 1,
    model: "claude-haiku-5-5",
    promptVersion: 1,
    inputHash: "a".repeat(64),
    createdAt: "2026-10-12T14:00:00.000Z",
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 0,
    },
    enrichment: valid,
  }

  it("keeps the fields of the spec and writes them in order", () => {
    const decoded = Schema.decodeUnknownSync(EnrichedRecipe)(stored)
    const text = Schema.encodeSync(EnrichedRecipeJson)(decoded)
    assert.deepStrictEqual(Object.keys(JSON.parse(text)), Object.keys(stored))
    assert.deepStrictEqual(Schema.decodeUnknownSync(EnrichedRecipeJson)(text), decoded)
  })

  it.each([
    ["another version", { enrichmentVersion: 2 }],
    ["an unknown model", { model: "claude-opus-5" }],
    ["a short hash", { inputHash: "abc" }],
    ["a time without Z", { createdAt: "2026-10-12 14:00" }],
    [
      "negative usage",
      {
        usage: {
          inputTokens: -1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ],
  ])("rejects %s", (_name, changes) => {
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(EnrichedRecipe)({ ...stored, ...changes })))
  })
})
