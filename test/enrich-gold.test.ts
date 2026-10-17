import { existsSync, readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { GoldJson } from "../src/domain/gold.ts"
import { RecipeId } from "../src/domain/recipe.ts"
import { parseRecipe } from "../src/parser/parse.ts"
import { isInScope } from "../src/enrich/scope.ts"

const GOLD_URL = new URL("./fixtures/gold.json", import.meta.url)
const FIXTURE_DIR = new URL("./fixtures/real/", import.meta.url)

const gold = Schema.decodeUnknownSync(GoldJson)(readFileSync(GOLD_URL, "utf8"))
const recipeId = Schema.decodeUnknownSync(RecipeId)

describe("test/fixtures/gold.json (spec P3.5)", () => {
  it("has 20 recipes with unique IDs, in ascending order", () => {
    assert.lengthOf(gold, 20)
    assert.strictEqual(new Set(gold.map((entry) => entry.id)).size, 20)
    assert.deepStrictEqual(
      gold.map((entry) => entry.id),
      gold.map((entry) => entry.id).toSorted((a, b) => a - b)
    )
  })

  it("has the 20 IDs that the README of the project names", () => {
    assert.deepStrictEqual<ReadonlyArray<number>>(
      gold.map((entry) => entry.id),
      [38, 61, 246, 935, 1057, 1171, 1282, 1321, 1429, 1434, 1587, 1601, 1623, 1635, 1653, 1676, 1679, 1688, 1701, 1731]
    )
  })

  it("has ranges where the minimum is not above the maximum", () => {
    for (const entry of gold) {
      assert.isAtMost(entry.heat.min, entry.heat.max, `${entry.id} heat`)
      assert.isAtMost(entry.activeMinutes.min, entry.activeMinutes.max, `${entry.id} activeMinutes`)
      assert.isAtMost(entry.servings.min, entry.servings.max, `${entry.id} servings`)
      assert.isTrue(entry.heat.min >= 0 && entry.heat.max <= 3, `${entry.id} heat range`)
    }
  })

  it("has 3 key lines for each recipe, and each line is unique in its recipe", () => {
    for (const entry of gold) {
      assert.lengthOf(entry.keyLines, 3, `${entry.id}`)
      assert.strictEqual(new Set(entry.keyLines.map((line) => line.raw)).size, entry.keyLines.length, `${entry.id}`)
    }
  })

  for (const entry of gold) {
    it(`${entry.id}: the page parses, is in scope, and has every key line exactly once`, (context) => {
      const file = new URL(`${entry.id}.html`, FIXTURE_DIR)
      context.skip(
        !existsSync(file),
        `The page test/fixtures/real/${entry.id}.html is absent (the pages are git-ignored). Run \`npm run fixtures:refresh\`.`
      )
      const parsed = parseRecipe(readFileSync(file, "utf8"), recipeId(entry.id))
      if (Result.isFailure(parsed)) {
        return assert.fail(`${entry.id}: ${parsed.failure.message}`)
      }
      const recipe = parsed.success
      assert.strictEqual(recipe.title, entry.title)
      assert.isTrue(isInScope(recipe), `${entry.id} is out of scope`)
      const lines = recipe.ingredientGroups.flatMap((group) => group.items)
      for (const keyLine of entry.keyLines) {
        assert.strictEqual(lines.filter((line) => line === keyLine.raw).length, 1, `${entry.id}: ${keyLine.raw}`)
      }
    })
  }
})
