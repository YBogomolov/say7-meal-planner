import { existsSync, readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { ConfigError, loadItemProtein } from "../src/planner/config.ts"
import { PlannerPaths } from "../src/planner/paths.ts"
import { makeAliases } from "../src/planner/items.ts"
import { ItemProteinJson, makeProteinTable, missingProteinItems, portionProtein } from "../src/planner/protein.ts"
import { searchRecipes } from "../src/planner/search.ts"
import { catalogueOf, entryOf, ing, inGrams, withTempDir, writeFiles } from "./support/planner.ts"

const table = (record: Record<string, number>) => makeProteinTable(record, makeAliases({}))
const servings = (min: number, max: number) => ({
  servings: { min, max, source: "page" as const },
})

describe("portionProtein", () => {
  it("sums grams × protein / 100 and divides by the middle of the servings", () => {
    const entry = entryOf(1, {
      enrichment: servings(3, 5),
      ingredients: [inGrams("курица", 400, { category: "poultry" }), inGrams("творог", 200, { category: "dairy" })],
    })
    // (400 × 20 + 200 × 15) / 100 = 110 g for 4 portions
    assert.deepStrictEqual(portionProtein(entry, table({ курица: 20, творог: 15 })), { grams: 27.5, coverage: 1 })
  })

  it("rounds to 1 decimal", () => {
    const entry = entryOf(1, {
      enrichment: servings(3, 3),
      ingredients: [inGrams("курица", 100, { category: "poultry" })],
    })
    assert.strictEqual(portionProtein(entry, table({ курица: 10 })).grams, 3.3)
  })

  it("leaves out optional lines and counts pantry lines", () => {
    const entry = entryOf(1, {
      enrichment: servings(1, 1),
      ingredients: [
        inGrams("мука", 100, { category: "grain", pantry: true }),
        inGrams("сыр", 100, { category: "dairy", optional: true }),
      ],
    })
    const result = portionProtein(entry, table({ мука: 10, сыр: 25 }))
    assert.strictEqual(result.grams, 10)
  })

  it("adds 0 for a line without grams or without a table entry, and lowers the coverage", () => {
    const entry = entryOf(1, {
      enrichment: servings(2, 2),
      ingredients: [
        inGrams("курица", 200, { category: "poultry" }),
        ing("яйца", { category: "eggs", quantity: 2, unit: "pcs" }),
        inGrams("тофу", 100, { category: "other" }),
        inGrams("рыба", 100, { category: "fish" }),
      ],
    })
    // relevant: курица, яйца (no grams), рыба (no entry); тофу has 8 in the table, so it is relevant too (no entry → not)
    const result = portionProtein(entry, table({ курица: 20, яйца: 12, тофу: 8 }))
    assert.strictEqual(result.grams, (28.0 / 1) * 0 + (200 * 20 + 100 * 8) / 100 / 2)
    assert.strictEqual(result.coverage, 2 / 4)
  })

  it("never counts spice, herb and oil lines as relevant, even with a high table value", () => {
    const entry = entryOf(1, {
      enrichment: servings(1, 1),
      ingredients: [
        inGrams("курица", 100, { category: "poultry" }),
        ing("паприка", { category: "spice" }),
        ing("семена", { category: "oil" }),
      ],
    })
    assert.strictEqual(portionProtein(entry, table({ курица: 20, паприка: 14, семена: 18 })).coverage, 1)
  })

  it("has coverage 1 for a dish without relevant lines", () => {
    const entry = entryOf(1, {
      ingredients: [inGrams("морковь", 200, { category: "vegetable" })],
    })
    assert.deepStrictEqual(portionProtein(entry, table({})), {
      grams: 0,
      coverage: 1,
    })
  })
})

describe("loadItemProtein", () => {
  it.live("gives an empty table for a missing file", () =>
    withTempDir(() =>
      Effect.gen(function* () {
        assert.strictEqual((yield* loadItemProtein()).size, 0)
      })
    )
  )

  it.live("cleans the names and maps them through the aliases", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* writeFiles(root, {
          "config/item-protein.json": '{"Куриные Бёдра": 20, "творог": 16}',
        })
        const loaded = yield* loadItemProtein(makeAliases({ "куриные бедра": "куриное филе" }))
        assert.deepStrictEqual([...loaded.entries()].sort(), [
          ["куриное филе", 20],
          ["творог", 16],
        ])
      })
    )
  )

  it.live("fails with ConfigError for a negative value and for bad JSON", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* writeFiles(root, {
          "a/item-protein.json": '{"x": -1}',
          "b/item-protein.json": "{",
        })
        for (const dir of ["a", "b"]) {
          const result = yield* Effect.result(
            loadItemProtein().pipe(
              Effect.provide(PlannerPaths.layer({ dataDir: `${root}/data`, configDir: `${root}/${dir}` }))
            )
          )
          assert.isTrue(Result.isFailure(result))
          assert.instanceOf(Result.isFailure(result) ? result.failure : undefined, ConfigError)
        }
      })
    )
  )
})

describe("missingProteinItems", () => {
  it("lists the items of the catalogue without a table entry, sorted", () => {
    const catalogue = catalogueOf(
      [
        entryOf(1, {
          ingredients: [inGrams("яйца", 100), inGrams("творог", 100)],
        }),
        entryOf(2, {
          ingredients: [inGrams("яйца", 50), inGrams("авокадо", 50)],
        }),
      ],
      undefined,
      table({ яйца: 12 })
    )
    assert.deepStrictEqual(missingProteinItems(catalogue), ["авокадо", "творог"])
  })
})

describe("searchRecipes: proteinPerPortion", () => {
  it("is in each row, with 1 decimal", () => {
    const catalogue = catalogueOf(
      [
        entryOf(1, {
          enrichment: servings(3, 3),
          ingredients: [inGrams("курица", 100, { category: "poultry" })],
        }),
      ],
      undefined,
      table({ курица: 10 })
    )
    assert.strictEqual(searchRecipes(catalogue, {})[0]?.proteinPerPortion, 3.3)
  })

  it("is 0 without a table", () => {
    const catalogue = catalogueOf([entryOf(1)])
    assert.strictEqual(searchRecipes(catalogue, {})[0]?.proteinPerPortion, 0)
  })
})

describe("config/item-protein.json", () => {
  const file = new URL("../config/item-protein.json", import.meta.url)

  it.skipIf(!existsSync(file))("decodes with the schema", () => {
    const record = Schema.decodeUnknownSync(ItemProteinJson)(readFileSync(file, "utf8"))
    assert.isAbove(Object.keys(record).length, 0)
  })
})
