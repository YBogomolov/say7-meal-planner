import { assert, describe, it } from "@effect/vitest"
import { extraScopeIds, isInScope, SCOPE_CATEGORY_IDS } from "../src/enrich/scope.ts"
import { DESSERTS, id, parsedRecipe, SALADS, SOUPS } from "./support/enrich.ts"

const category = (id: number) => ({
  id,
  slug: `c${id}`,
  name: `Категория ${id}`,
})

describe("isInScope", () => {
  it("lists the 8 categories of the spec P3.1 and P7.2.5", () => {
    assert.deepStrictEqual(
      [...SCOPE_CATEGORY_IDS].toSorted((a, b) => a - b),
      [38, 40, 41, 44, 47, 48, 50, 233]
    )
  })

  it.each([38, 40, 41, 44, 47, 48, 50, 233])("accepts category %i", (id) => {
    assert.isTrue(isInScope(parsedRecipe(1, { categories: [category(id)] })))
  })

  it("refuses a recipe that has only categories out of scope", () => {
    assert.isFalse(isInScope(parsedRecipe(1, { categories: [DESSERTS] })))
    assert.isFalse(
      isInScope(
        parsedRecipe(1, {
          categories: [category(39), category(42), category(99)],
        })
      )
    )
  })

  it("accepts a recipe when at least 1 of its categories is in scope", () => {
    assert.isTrue(isInScope(parsedRecipe(1, { categories: [DESSERTS, SALADS] })))
    assert.isTrue(isInScope(parsedRecipe(1, { categories: [SOUPS, DESSERTS] })))
  })

  it("refuses a recipe with no category", () => {
    assert.isFalse(isInScope(parsedRecipe(1, { categories: [] })))
  })
})

describe("isInScope: extra IDs (spec P7.4.1)", () => {
  it("accepts a recipe of the extra IDs although its categories are out of scope", () => {
    assert.isTrue(isInScope(parsedRecipe(5, { categories: [DESSERTS] }), new Set([id(5)])))
    assert.isTrue(isInScope(parsedRecipe(5, { categories: [] }), new Set([id(5)])))
  })

  it("refuses a recipe that is neither in a category nor in the extra IDs", () => {
    assert.isFalse(isInScope(parsedRecipe(5, { categories: [DESSERTS] }), new Set([id(6)])))
    assert.isFalse(isInScope(parsedRecipe(5, { categories: [DESSERTS] })))
  })

  it("still accepts a category in scope when the extra IDs name other recipes", () => {
    assert.isTrue(isInScope(parsedRecipe(5, { categories: [SALADS] }), new Set([id(6)])))
  })

  it("extraScopeIds joins breakfastExtraIds and lightDinnerIds", () => {
    const ids = extraScopeIds({ breakfastExtraIds: [id(1), id(2)], lightDinnerIds: [id(2), id(3)] })
    assert.deepStrictEqual(
      [...ids].toSorted((a, b) => a - b),
      [1, 2, 3]
    )
  })
})
