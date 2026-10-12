import { assert, describe, it } from "@effect/vitest"
import { isInScope, SCOPE_CATEGORY_IDS } from "../src/enrich/scope.ts"
import { DESSERTS, parsedRecipe, SALADS, SOUPS } from "./support/enrich.ts"

const category = (id: number) => ({ id, slug: `c${id}`, name: `Категория ${id}` })

describe("isInScope", () => {
  it("lists the 7 categories of the spec P3.1", () => {
    assert.deepStrictEqual([...SCOPE_CATEGORY_IDS].toSorted((a, b) => a - b), [38, 40, 41, 44, 47, 48, 50])
  })

  it.each([38, 40, 41, 44, 47, 48, 50])("accepts category %i", (id) => {
    assert.isTrue(isInScope(parsedRecipe(1, { categories: [category(id)] })))
  })

  it("refuses a recipe that has only categories out of scope", () => {
    assert.isFalse(isInScope(parsedRecipe(1, { categories: [DESSERTS] })))
    assert.isFalse(isInScope(parsedRecipe(1, { categories: [category(39), category(42), category(99)] })))
  })

  it("accepts a recipe when at least 1 of its categories is in scope", () => {
    assert.isTrue(isInScope(parsedRecipe(1, { categories: [DESSERTS, SALADS] })))
    assert.isTrue(isInScope(parsedRecipe(1, { categories: [SOUPS, DESSERTS] })))
  })

  it("refuses a recipe with no category", () => {
    assert.isFalse(isInScope(parsedRecipe(1, { categories: [] })))
  })
})
