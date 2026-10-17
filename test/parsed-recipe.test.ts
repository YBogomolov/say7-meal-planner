import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { ParsedRecipe, ParsedRecipeJson, ParseError, Servings, StepDuration } from "../src/domain/parsed-recipe.ts"
import { RecipeId } from "../src/domain/recipe.ts"

const valid = {
  parserVersion: 1,
  id: 77,
  url: "https://www.say7.info/cook/recipe/77-Test.html",
  title: "Тест",
  intro: [],
  categories: [{ id: 38, slug: "Salatyi", name: "Салаты" }],
  ingredientGroups: [{ title: null, items: ["соль"] }],
  steps: ["Посолить."],
  yieldText: "4–6 порций",
  servingsText: "4–6 порций",
  servings: { min: 4, max: 6 },
  durations: [],
  longWait: false,
  addedAt: "2023-12-05",
  commentsCount: 0,
  similarIds: [5],
  sourceSha256: "a".repeat(64),
}

const accepts = (value: unknown): boolean => Result.isSuccess(Schema.decodeUnknownResult(ParsedRecipe)(value))

describe("ParsedRecipe", () => {
  it("accepts a complete value and keeps it through the JSON codec", () => {
    assert.isTrue(accepts(valid))
    const decoded = Schema.decodeUnknownSync(ParsedRecipe)(valid)
    const text = Schema.encodeSync(ParsedRecipeJson)(decoded)
    assert.deepStrictEqual(Schema.decodeUnknownSync(ParsedRecipeJson)(text), decoded)
  })

  it("writes the fields in the order of the spec", () => {
    const text = Schema.encodeSync(ParsedRecipeJson)(Schema.decodeUnknownSync(ParsedRecipe)(valid))
    assert.deepStrictEqual(Object.keys(JSON.parse(text)), Object.keys(valid))
  })

  it.each([
    ["another parser version", { ...valid, parserVersion: 2 }],
    ["an ID of 0", { ...valid, id: 0 }],
    ["an empty title", { ...valid, title: "" }],
    ["no ingredient group", { ...valid, ingredientGroups: [] }],
    ["an ingredient group without lines", { ...valid, ingredientGroups: [{ title: "x", items: [] }] }],
    ["no step", { ...valid, steps: [] }],
    ["an empty step", { ...valid, steps: [""] }],
    ["a date that is not YYYY-MM-DD", { ...valid, addedAt: "05.12.2023" }],
    ["a negative comments count", { ...valid, commentsCount: -1 }],
    ["a short hash", { ...valid, sourceSha256: "abc" }],
    ["an ID of 0 in similarIds", { ...valid, similarIds: [0] }],
    ["an empty yield text", { ...valid, yieldText: "" }],
    ["a missing yield text", { ...valid, yieldText: undefined }],
    ["a missing field", { ...valid, longWait: undefined }],
  ])("rejects %s", (_name, value) => {
    assert.isFalse(accepts(value))
  })
})

describe("Servings and StepDuration", () => {
  it("require min <= max", () => {
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(Servings)({ min: 4, max: 4 })))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(Servings)({ min: 6, max: 4 })))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(Servings)({ min: 0, max: 4 })))
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(StepDuration)({
          minMinutes: 5,
          maxMinutes: 7,
          text: "5–7 минут",
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(StepDuration)({
          minMinutes: 8,
          maxMinutes: 7,
          text: "x",
        })
      )
    )
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(StepDuration)({
          minMinutes: 1.5,
          maxMinutes: 2,
          text: "x",
        })
      )
    )
  })
})

describe("ParseError", () => {
  it("is a tagged error with the ID, the reason and a message", () => {
    const error = new ParseError({
      id: Schema.decodeUnknownSync(RecipeId)(5),
      reason: "no_steps",
      message: "no step",
    })
    assert.strictEqual(error._tag, "ParseError")
    assert.strictEqual(error.reason, "no_steps")
  })
})
