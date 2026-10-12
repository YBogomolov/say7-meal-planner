import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import type { RecipeId } from "../src/domain/recipe.ts"
import { buildModelInput, computeInputHash } from "../src/enrich/input.ts"
import { BATCH_THRESHOLD, chooseMode, customIdOf, planEnrichment, selectIds, SYNC_CONCURRENCY } from "../src/enrich/plan.ts"
import { DESSERTS, id, idSet, parsedRecipe, SALADS } from "./support/enrich.ts"

const ids = (...numbers: ReadonlyArray<number>): ReadonlyArray<RecipeId> => numbers.map(id)

describe("selectIds", () => {
  it("takes all IDs in ascending order without the flag", () => {
    assert.deepStrictEqual<ReadonlyArray<number>>(selectIds(ids(30, 5, 100), Option.none()).selected, [5, 30, 100])
  })

  it("takes the requested IDs that exist, and names the others", () => {
    const selection = selectIds(ids(30, 5, 100), idSet(100, 7, 5, 6))
    assert.deepStrictEqual<ReadonlyArray<number>>(selection.selected, [5, 100])
    assert.deepStrictEqual<ReadonlyArray<number>>(selection.unknown, [6, 7])
  })
})

describe("planEnrichment", () => {
  const base = { model: "claude-haiku-5-5", promptVersion: 1, storedHashes: new Map<RecipeId, string>(), limit: Option.none<number>() } as const
  const recipes = [parsedRecipe(30), parsedRecipe(5, { categories: [SALADS] }), parsedRecipe(9, { categories: [DESSERTS] }), parsedRecipe(12)]

  it("processes the recipes in scope in ascending order of ID and skips the others", () => {
    const plan = planEnrichment({ ...base, recipes })
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.toProcess.map((recipe) => recipe.id), [5, 12, 30])
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.outOfScope, [9])
    assert.deepStrictEqual(plan.cached, [])
    assert.strictEqual(plan.deferred, 0)
  })

  it("gives each recipe its input, its line count and its hash", () => {
    const recipe = parsedRecipe(5, { lines: ["a", "b", "c"] })
    const plan = planEnrichment({ ...base, recipes: [recipe] })
    const planned = plan.toProcess[0]
    assert.strictEqual(planned?.lineCount, 3)
    assert.deepStrictEqual(planned?.input, buildModelInput(recipe))
    assert.strictEqual(
      planned?.inputHash,
      computeInputHash({ input: buildModelInput(recipe), promptVersion: 1, model: "claude-haiku-5-5" })
    )
  })

  it("skips a recipe whose stored hash is the current hash (spec A8)", () => {
    const hash = planEnrichment({ ...base, recipes }).toProcess.find((recipe) => recipe.id === 12)?.inputHash ?? ""
    const plan = planEnrichment({ ...base, recipes, storedHashes: new Map([[id(12), hash]]) })
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.cached, [12])
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.toProcess.map((recipe) => recipe.id), [5, 30])
  })

  it("processes a recipe again when its hash is old, or when the model or prompt version is new", () => {
    const old = planEnrichment({ ...base, recipes })
    const stored = new Map(old.toProcess.map((recipe) => [recipe.id, recipe.inputHash] as const))
    assert.strictEqual(planEnrichment({ ...base, recipes, storedHashes: stored }).toProcess.length, 0)
    assert.strictEqual(planEnrichment({ ...base, recipes, storedHashes: stored, promptVersion: 2 }).toProcess.length, 3)
    assert.strictEqual(planEnrichment({ ...base, recipes, storedHashes: stored, model: "claude-sonnet-5-5" }).toProcess.length, 3)
    const edited = [parsedRecipe(5, { categories: [SALADS], lines: ["x"] }), ...recipes.filter((recipe) => recipe.id !== 5)]
    const again = planEnrichment({ ...base, recipes: edited, storedHashes: stored })
    assert.deepStrictEqual<ReadonlyArray<number>>(again.toProcess.map((recipe) => recipe.id), [5])
    assert.deepStrictEqual<ReadonlyArray<number>>(again.cached, [12, 30])
  })

  it("does not count a cached recipe that is out of scope as cached", () => {
    const plan = planEnrichment({ ...base, recipes, storedHashes: new Map([[id(9), "x"]]) })
    assert.deepStrictEqual(plan.cached, [])
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.outOfScope, [9])
  })

  it("takes the first n recipes with --limit and counts the others as deferred", () => {
    const plan = planEnrichment({ ...base, recipes, limit: Option.some(2) })
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.toProcess.map((recipe) => recipe.id), [5, 12])
    assert.strictEqual(plan.deferred, 1)
  })

  it("does not count cached recipes against --limit", () => {
    const first = planEnrichment({ ...base, recipes }).toProcess[0]?.inputHash ?? ""
    const plan = planEnrichment({ ...base, recipes, storedHashes: new Map([[id(5), first]]), limit: Option.some(1) })
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.toProcess.map((recipe) => recipe.id), [12])
    assert.strictEqual(plan.deferred, 1)
  })

  it("accepts a limit above the number of recipes", () => {
    const plan = planEnrichment({ ...base, recipes, limit: Option.some(100) })
    assert.strictEqual(plan.toProcess.length, 3)
    assert.strictEqual(plan.deferred, 0)
  })
})

describe("chooseMode (spec A5, A9)", () => {
  const mode = (count: number, sync = false, retryFailed = false) => chooseMode({ count, sync, retryFailed })

  it("uses the constants of the spec", () => {
    assert.strictEqual(BATCH_THRESHOLD, 20)
    assert.strictEqual(SYNC_CONCURRENCY, 4)
  })

  it("uses sync for 20 recipes or fewer and batch for 21 or more", () => {
    assert.strictEqual(mode(0), "sync")
    assert.strictEqual(mode(1), "sync")
    assert.strictEqual(mode(20), "sync")
    assert.strictEqual(mode(21), "batch")
    assert.strictEqual(mode(2000), "batch")
  })

  it("uses sync with --sync", () => {
    assert.strictEqual(mode(500, true), "sync")
  })

  it("uses sync with --retry-failed", () => {
    assert.strictEqual(mode(500, false, true), "sync")
  })
})

describe("customIdOf", () => {
  it("gives a valid custom_id (1 to 64 letters, digits, _ and -)", () => {
    assert.strictEqual(customIdOf(id(1731)), "recipe-1731")
    assert.match(customIdOf(id(99999999)), /^[A-Za-z0-9_-]{1,64}$/)
  })
})
