import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { loadCatalogue, makeCatalogue } from "../src/planner/catalogue.ts"
import { ConfigError, loadServingsOverrides } from "../src/planner/config.ts"
import { NO_SERVINGS_OVERRIDES, servingsAudit } from "../src/planner/servings.ts"
import { DESSERTS, SOUPS } from "./support/enrich.ts"
import {
  catalogueOf,
  enrichedJson,
  entryOf,
  ing,
  inGrams,
  parsedJson,
  withTempDir,
  writeFiles,
} from "./support/planner.ts"
import type { DishOptions } from "./support/planner.ts"

/** A dish with 1 ingredient of `grams`, so the portion mass is `grams / max`. */
const dish = (n: number, min: number, max: number, grams: number, options: DishOptions = {}) =>
  entryOf(n, {
    ...options,
    ingredients: options.ingredients ?? [inGrams("продукт", grams)],
    enrichment: {
      servings: { min, max, source: "page" },
      ...options.enrichment,
    },
  })

const reasonsOf = (entries: ReadonlyArray<ReturnType<typeof entryOf>>, n: number) =>
  servingsAudit(catalogueOf(entries)).entries.find((entry) => Number(entry.id) === n)?.reasons ?? []

describe("servingsAudit", () => {
  it("does not flag a normal recipe", () => {
    assert.deepStrictEqual(servingsAudit(catalogueOf([dish(1, 4, 4, 1600)])).entries, [])
  })

  it("flags estimated servings", () => {
    const entry = dish(1, 4, 4, 1600, {
      enrichment: { servings: { min: 4, max: 4, source: "estimated" } },
    })
    assert.deepStrictEqual(reasonsOf([entry], 1), ["estimated"])
  })

  it("flags servings.max above 12, not 12", () => {
    assert.deepStrictEqual(reasonsOf([dish(1, 12, 12, 6000)], 1), [])
    assert.deepStrictEqual(reasonsOf([dish(2, 13, 13, 6500)], 2), ["max_above_12"])
  })

  it("flags servings.max above 3 times min, not exactly 3 times", () => {
    assert.deepStrictEqual(reasonsOf([dish(1, 2, 6, 2400)], 1), [])
    assert.deepStrictEqual(reasonsOf([dish(2, 2, 7, 2800)], 2), ["range_above_3x"])
  })

  it("flags a portion mass outside 150 to 700 g, not at the borders", () => {
    assert.deepStrictEqual(reasonsOf([dish(1, 4, 4, 600)], 1), [])
    assert.deepStrictEqual(reasonsOf([dish(2, 4, 4, 2800)], 2), [])
    assert.deepStrictEqual(reasonsOf([dish(3, 4, 4, 599)], 3), ["portion_mass_out_of_range"])
    assert.deepStrictEqual(reasonsOf([dish(4, 4, 4, 2801)], 4), ["portion_mass_out_of_range"])
  })

  it("divides the mass by servings.max", () => {
    // 1000 g / 2 = 500 g is fine. 1000 g / 4 = 250 g is fine. 1000 g / 8 = 125 g is not.
    assert.deepStrictEqual(reasonsOf([dish(1, 2, 6, 1000)], 1), [])
    assert.deepStrictEqual(reasonsOf([dish(2, 4, 8, 1000)], 2), ["portion_mass_out_of_range"])
  })

  it("leaves out the optional lines from the mass and the coverage", () => {
    const entry = dish(1, 1, 1, 0, {
      ingredients: [inGrams("мясо", 400), inGrams("укроп", 5000, { optional: true }), ing("лимон", { optional: true })],
    })
    const [flagged] = servingsAudit(catalogueOf([entry])).entries
    assert.strictEqual(flagged, undefined)
  })

  it("skips the mass check if less than 70 % of the lines have grams, and runs it at 70 %", () => {
    const lines = (withGrams: number) => [
      ...Array.from({ length: withGrams }, (_, i) => inGrams(`с граммами ${i}`, 10)),
      ...Array.from({ length: 10 - withGrams }, (_, i) => ing(`без граммов ${i}`)),
    ]
    const at69 = servingsAudit(
      catalogueOf([
        dish(1, 4, 4, 0, {
          ingredients: [...lines(6), ing("x1"), ing("x2"), ing("x3"), ing("x4"), inGrams("y", 10)].slice(0, 10),
        }),
      ])
    )
    assert.deepStrictEqual(at69.entries, [])
    const at70 = servingsAudit(catalogueOf([dish(2, 4, 4, 0, { ingredients: lines(7) })]))
    assert.strictEqual(at70.entries.length, 1)
    assert.deepStrictEqual(at70.entries[0]?.reasons, ["portion_mass_out_of_range"])
    assert.strictEqual(at70.entries[0]?.gramsCoverage, 0.7)
    assert.strictEqual(at70.entries[0]?.portionGrams, 17.5)
  })

  it("reports the coverage and no mass when the check is skipped, for another reason", () => {
    const entry = dish(1, 4, 20, 0, {
      ingredients: [inGrams("а", 10), ing("б"), ing("в")],
    })
    const [flagged] = servingsAudit(catalogueOf([entry])).entries
    assert.deepStrictEqual(flagged?.reasons, ["max_above_12", "range_above_3x"])
    assert.strictEqual(flagged?.portionGrams, null)
    assert.strictEqual(flagged?.gramsCoverage, 0.333)
  })

  it("gives all reasons of a recipe, in a fixed order", () => {
    const entry = dish(1, 2, 30, 100, {
      enrichment: { servings: { min: 2, max: 30, source: "estimated" } },
    })
    assert.deepStrictEqual(reasonsOf([entry], 1), [
      "estimated",
      "max_above_12",
      "range_above_3x",
      "portion_mass_out_of_range",
    ])
  })

  it("does not flag an overridden range as estimated, but keeps the other checks", () => {
    const entry = dish(1, 2, 30, 100, {
      enrichment: { servings: { min: 2, max: 30, source: "estimated" } },
    })
    const [flagged] = servingsAudit(makeCatalogue([entry], undefined, new Set([entry.id]))).entries
    assert.deepStrictEqual(flagged?.reasons, ["max_above_12", "range_above_3x", "portion_mass_out_of_range"])
    assert.strictEqual(flagged?.overridden, true)
  })

  it("sorts main, soup and salad first, then by ID, and counts the reasons", () => {
    const bad = (n: number, dishType: "main" | "soup" | "salad" | "side" | "sauce") =>
      dish(n, 5, 13, 6500, { enrichment: { dishType } })
    const audit = servingsAudit(
      catalogueOf([bad(1, "side"), bad(2, "salad"), bad(3, "main"), bad(4, "sauce"), bad(5, "soup"), bad(6, "main")])
    )
    assert.deepStrictEqual(
      audit.entries.map((entry) => Number(entry.id)),
      [3, 6, 5, 2, 1, 4]
    )
    assert.strictEqual(audit.flaggedMainSoupSalad, 4)
    assert.strictEqual(audit.recipes, 6)
    assert.deepStrictEqual(audit.reasons, {
      estimated: 0,
      max_above_12: 6,
      range_above_3x: 0,
      portion_mass_out_of_range: 0,
    })
  })

  it("copies the id, title, url, dish type and servings", () => {
    const [flagged] = servingsAudit(
      catalogueOf([
        dish(7, 2, 13, 3000, {
          title: "Тестовый суп",
          enrichment: { dishType: "soup" },
        }),
      ])
    ).entries
    assert.strictEqual(Number(flagged?.id), 7)
    assert.strictEqual(flagged?.title, "Тестовый суп")
    assert.strictEqual(flagged?.dishType, "soup")
    assert.deepStrictEqual(flagged?.servings, {
      min: 2,
      max: 13,
      source: "page",
    })
    assert.isString(flagged?.url)
  })
})

const FILES = {
  "data/parsed/1.json": parsedJson(1, { categories: [SOUPS, DESSERTS] }),
  "data/enriched/1.json": enrichedJson(1, {
    ingredients: [inGrams("продукт", 2000)],
    enrichment: { servings: { min: 20, max: 30, source: "estimated" } },
  }),
} as const

describe("servings overrides", () => {
  it.live("override the servings of the enrichment and clear the estimated flag", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* writeFiles(root, {
          ...FILES,
          "config/servings-overrides.json": '{"1": {"min": 4, "max": 6}, "99": {"min": 1, "max": 1}}',
        })
        const overrides = yield* loadServingsOverrides(`${root}/config`)
        const { catalogue, unknownOverrides } = yield* loadCatalogue(`${root}/data`, undefined, overrides)
        const entry = catalogue.entries[0]
        assert.deepStrictEqual(entry?.enrichment.servings, {
          min: 4,
          max: 6,
          source: "estimated",
        })
        assert.deepStrictEqual([...catalogue.overridden], [entry?.id])
        assert.deepStrictEqual(unknownOverrides.map(Number), [99])
        assert.deepStrictEqual(servingsAudit(catalogue).entries, [])
      })
    )
  )

  it.live("leave the servings alone without an override", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* writeFiles(root, FILES)
        const { catalogue, unknownOverrides } = yield* loadCatalogue(`${root}/data`, undefined, NO_SERVINGS_OVERRIDES)
        assert.deepStrictEqual(catalogue.entries[0]?.enrichment.servings, {
          min: 20,
          max: 30,
          source: "estimated",
        })
        assert.strictEqual(catalogue.overridden.size, 0)
        assert.deepStrictEqual(unknownOverrides, [])
      })
    )
  )

  it.live("are empty if the file is missing", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* loadServingsOverrides(`${root}/config`)).size, 0)
      })
    )
  )

  it.live("fail with ConfigError that names the file, for invalid content", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        for (const bad of [
          '{"1": {"min": 5, "max": 4}}',
          '{"1": {"min": 0, "max": 4}}',
          '{"1": {"min": 1.5, "max": 4}}',
          '{"abc": {"min": 1, "max": 4}}',
          '{"1": {"min": 1}}',
          "{",
        ]) {
          yield* writeFiles(root, { "config/servings-overrides.json": bad })
          const error = yield* Effect.flip(loadServingsOverrides(`${root}/config`))
          assert.instanceOf(error, ConfigError, bad)
          assert.include(error.path, "servings-overrides.json", bad)
        }
      })
    )
  )
})
