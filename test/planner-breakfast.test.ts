import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { DEFAULT_HOUSEHOLD } from "../src/domain/household.ts"
import type { Household } from "../src/domain/household.ts"
import type { SimpleBreakfast } from "../src/domain/simple-breakfast.ts"
import { isBreakfastEligible } from "../src/planner/breakfast.ts"
import { loadCatalogue, toCatalogueEntry } from "../src/planner/catalogue.ts"
import { loadCatalogueExtras, loadSimpleBreakfasts } from "../src/planner/config.ts"
import { makeAliases } from "../src/planner/items.ts"
import { makeProteinTable, missingProteinItems, simpleProtein, ItemProteinJson } from "../src/planner/protein.ts"
import { searchRecipes } from "../src/planner/search.ts"
import { makeSimpleBreakfasts, SimpleBreakfastsJson } from "../src/planner/simple.ts"
import { shoppingList } from "../src/planner/shopping.ts"
import { DESSERTS, id, parsedRecipe, SOUPS } from "./support/enrich.ts"
import {
  baseCatalogue,
  baseEntries,
  BASE_COOKING,
  BASE_MEALS,
  catalogueOf,
  enrichedJson,
  enrichedRecipe,
  entryOf,
  inGrams,
  PANCAKES,
  parsedJson,
  planOf,
  withTempDir,
  writeFiles,
} from "./support/planner.ts"

const decodeSimple = (input: unknown) => Schema.decodeUnknownResult(SimpleBreakfastsJson)(JSON.stringify(input))

const YOGURT: SimpleBreakfast = {
  id: "yogurt",
  title: "Йогурт с бананом",
  meals: ["breakfast"],
  items: [
    { item: "греческий йогурт", grams: 200, category: "dairy", pantry: false },
    { item: "мед", grams: 15, category: "sweet", pantry: true },
  ],
}
const BRYNZA: SimpleBreakfast = {
  id: "brynza",
  title: "Брынза с хлебом",
  meals: ["breakfast"],
  items: [
    { item: "брынза", grams: 30, category: "dairy", pantry: false },
    { item: "хлеб", grams: 40, category: "bakery", pantry: false },
  ],
}

describe("isBreakfastEligible (spec P7.2.4)", () => {
  const withCategories = (ids: ReadonlyArray<number>) =>
    parsedRecipe(1, {
      categories: ids.map((categoryId) => ({
        id: categoryId,
        slug: `c${categoryId}`,
        name: `Категория ${categoryId}`,
      })),
    })

  it.each([50, 62, 63, 79, 233])("accepts category %i", (categoryId) => {
    assert.isTrue(isBreakfastEligible(withCategories([47, categoryId]), new Set()))
  })

  it("refuses other categories, and accepts an ID of breakfastExtraIds", () => {
    assert.isFalse(isBreakfastEligible(withCategories([47, 39]), new Set()))
    assert.isFalse(isBreakfastEligible(withCategories([]), new Set()))
    assert.isTrue(isBreakfastEligible(withCategories([47]), new Set([id(1)])))
  })

  it("marks the entry of the catalogue", () => {
    assert.isTrue(
      toCatalogueEntry(parsedRecipe(1, { categories: [PANCAKES] }), enrichedRecipe(1), new Map()).breakfastEligible
    )
    assert.isFalse(
      toCatalogueEntry(parsedRecipe(1, { categories: [SOUPS] }), enrichedRecipe(1), new Map()).breakfastEligible
    )
    assert.isTrue(
      toCatalogueEntry(parsedRecipe(1, { categories: [SOUPS] }), enrichedRecipe(1), new Map(), new Set([id(1)]))
        .breakfastEligible
    )
  })
})

describe("light dinners (spec P7.4)", () => {
  it("a light dinner is breakfast-eligible and the entry has the flag", () => {
    const parsed = parsedRecipe(1, { categories: [SOUPS] })
    assert.isTrue(isBreakfastEligible(parsed, new Set(), new Set([id(1)])))
    const entry = toCatalogueEntry(parsed, enrichedRecipe(1), new Map(), new Set(), new Set([id(1)]))
    assert.isTrue(entry.lightDinner)
    assert.isTrue(entry.breakfastEligible)
    assert.isFalse(toCatalogueEntry(parsed, enrichedRecipe(1), new Map(), new Set([id(1)])).lightDinner)
  })

  it.live("loadCatalogue keeps a not_a_meal light dinner, and loadCatalogueExtras reads household.lightDinnerIds", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* writeFiles(root, {
          "data/parsed/3.json": parsedJson(3, { categories: [DESSERTS] }),
          "data/enriched/3.json": enrichedJson(3, { enrichment: { mealFit: "not_a_meal", dishType: "other" } }),
          "data/parsed/2.json": parsedJson(2, { categories: [DESSERTS] }),
          "data/enriched/2.json": enrichedJson(2, { enrichment: { mealFit: "not_a_meal", dishType: "other" } }),
          "config/household.json": JSON.stringify({ lightDinnerIds: [3] }),
        })
        const extras = yield* loadCatalogueExtras()
        assert.deepStrictEqual(extras.lightDinnerIds?.map(Number), [3])
        const { catalogue, skipped } = yield* loadCatalogue({ extras })
        assert.deepStrictEqual(
          catalogue.entries.map((entry) => [Number(entry.id), entry.lightDinner, entry.breakfastEligible]),
          [[3, true, true]]
        )
        assert.deepStrictEqual(
          skipped.map((entry) => [Number(entry.id), entry.reason]),
          [[2, "not_a_meal"]]
        )
      })
    )
  )

  const catalogue = catalogueOf([
    entryOf(1, { title: "Суп Альфа" }),
    entryOf(3, { title: "Запеканка Чарли", lightDinner: true, enrichment: { mealFit: "not_a_meal" } }),
    entryOf(4, { title: "Кекс Дельта", enrichment: { mealFit: "not_a_meal" } }),
  ])
  const ids = (query: Parameters<typeof searchRecipes>[1]) =>
    searchRecipes(catalogue, query)
      .map((row) => Number(row.id))
      .sort((a, b) => a - b)

  it("search with forMeal dinner includes the light dinners only, and the row has the flag", () => {
    assert.deepStrictEqual(ids({ forMeal: "dinner" }), [1, 3])
    assert.deepStrictEqual(ids({ forMeal: "lunch" }), [1])
    assert.deepStrictEqual(ids({ forMeal: "breakfast" }), [3])
    assert.deepStrictEqual(
      searchRecipes(catalogue, { forMeal: "dinner" }).map((row) => [Number(row.id), row.lightDinner]),
      [
        [1, false],
        [3, true],
      ]
    )
  })
})

describe("simple breakfasts: meals (spec P7.4.3)", () => {
  const record = {
    id: "tvorog",
    title: "Творог",
    items: [{ item: "Творог", grams: 200, category: "dairy", pantry: false }],
  }

  it("defaults to breakfast, and accepts a list of meals", () => {
    assert.deepStrictEqual(Result.getOrThrow(decodeSimple([record]))[0]?.meals, ["breakfast"])
    assert.deepStrictEqual(Result.getOrThrow(decodeSimple([{ ...record, meals: ["breakfast", "dinner"] }]))[0]?.meals, [
      "breakfast",
      "dinner",
    ])
  })

  it("refuses an empty list, a repeated meal and an unknown meal", () => {
    for (const meals of [[], ["dinner", "dinner"], ["supper"]]) {
      assert.isTrue(Result.isFailure(decodeSimple([{ ...record, meals }])))
    }
  })

  it("makeSimpleBreakfasts keeps the meals", () => {
    const decoded = Result.getOrThrow(decodeSimple([{ ...record, meals: ["dinner"] }]))
    assert.deepStrictEqual(makeSimpleBreakfasts(decoded, makeAliases({}))[0]?.meals, ["dinner"])
  })
})

describe("loadCatalogue: not_a_meal recipes of breakfast", () => {
  const NOT_A_MEAL = { mealFit: "not_a_meal", dishType: "other" } as const
  const FILES = {
    // 1: a sweet cottage cheese bake (category 50): kept.
    "data/parsed/1.json": parsedJson(1, { categories: [PANCAKES, DESSERTS] }),
    "data/enriched/1.json": enrichedJson(1, { enrichment: NOT_A_MEAL }),
    // 2: not a meal and no breakfast category: skipped.
    "data/parsed/2.json": parsedJson(2, { categories: [DESSERTS] }),
    "data/enriched/2.json": enrichedJson(2, { enrichment: NOT_A_MEAL }),
    // 3: not a meal, in the list of extra IDs: kept.
    "data/parsed/3.json": parsedJson(3, { categories: [DESSERTS] }),
    "data/enriched/3.json": enrichedJson(3, { enrichment: NOT_A_MEAL }),
    // 4: a dish for any meal, no breakfast category.
    "data/parsed/4.json": parsedJson(4, { categories: [SOUPS] }),
    "data/enriched/4.json": enrichedJson(4),
  }

  it.live("keeps a breakfast candidate with mealFit not_a_meal, and marks it", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* writeFiles(root, FILES)
        const { catalogue, skipped } = yield* loadCatalogue()
        assert.deepStrictEqual(
          catalogue.entries.map((entry) => [Number(entry.id), entry.breakfastEligible]),
          [
            [1, true],
            [4, false],
          ]
        )
        assert.deepStrictEqual(
          skipped.map((entry) => [Number(entry.id), entry.reason]),
          [
            [2, "not_a_meal"],
            [3, "not_a_meal"],
          ]
        )
      })
    )
  )

  it.live("keeps a recipe of household.breakfastExtraIds, and carries the simple breakfasts", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* writeFiles(root, FILES)
        const { catalogue } = yield* loadCatalogue({
          extras: {
            breakfastExtraIds: [id(3)],
            simpleBreakfasts: [YOGURT],
          },
        })
        assert.deepStrictEqual(
          catalogue.entries.map((entry) => Number(entry.id)),
          [1, 3, 4]
        )
        assert.deepStrictEqual(catalogue.simpleBreakfasts, [YOGURT])
        assert.strictEqual(catalogue.simpleById.get("yogurt"), YOGURT)
      })
    )
  )
})

describe("searchRecipes: forMeal (spec P7.2.4)", () => {
  const catalogue = catalogueOf([
    entryOf(1, { title: "Суп Альфа" }),
    entryOf(2, { title: "Сырники Браво", categories: [PANCAKES] }),
    entryOf(3, {
      title: "Кекс Чарли",
      categories: [PANCAKES],
      enrichment: { mealFit: "not_a_meal" },
    }),
    entryOf(4, {
      title: "Запеканка Дельта",
      enrichment: { mealFit: "not_a_meal" },
    }),
  ])
  const ids = (query: Parameters<typeof searchRecipes>[1]) =>
    searchRecipes(catalogue, query)
      .map((row) => Number(row.id))
      .sort((a, b) => a - b)

  it("breakfast finds the breakfast candidates, also a not_a_meal one", () => {
    assert.deepStrictEqual(ids({ forMeal: "breakfast" }), [2, 3])
  })

  it("lunch and dinner leave not_a_meal recipes out", () => {
    assert.deepStrictEqual(ids({ forMeal: "lunch" }), [1, 2])
    assert.deepStrictEqual(ids({ forMeal: "dinner" }), [1, 2])
  })

  it("without forMeal a not_a_meal recipe is left out, unless mealFits names it", () => {
    assert.deepStrictEqual(ids({}), [1, 2])
    assert.deepStrictEqual(ids({ mealFits: ["not_a_meal"] }), [3, 4])
  })

  it("the row says whether the recipe is a breakfast candidate", () => {
    const rows = searchRecipes(catalogue, {
      forMeal: "breakfast",
      sort: "popular",
    })
    assert.isTrue(rows.every((row) => row.breakfastEligible))
    assert.isFalse(searchRecipes(catalogue, { text: "суп" })[0]?.breakfastEligible)
  })
})

describe("simple breakfasts: the config file (spec P7.2.3)", () => {
  const record = {
    id: "tvorog",
    title: "Творог",
    items: [{ item: "Творог", grams: 200, category: "dairy", pantry: false }],
  }

  it("decodes a list, and refuses a repeated ID, a bad ID, an empty list of items and a bad amount", () => {
    assert.isTrue(Result.isSuccess(decodeSimple([record])))
    assert.isTrue(Result.isFailure(decodeSimple([record, record])))
    assert.isTrue(Result.isFailure(decodeSimple([{ ...record, id: "Творог" }])))
    assert.isTrue(Result.isFailure(decodeSimple([{ ...record, id: "Two Words" }])))
    assert.isTrue(Result.isFailure(decodeSimple([{ ...record, items: [] }])))
    assert.isTrue(Result.isFailure(decodeSimple([{ ...record, items: [{ ...record.items[0], grams: 0 }] }])))
    assert.isTrue(Result.isFailure(decodeSimple([{ ...record, items: [{ ...record.items[0], category: "unknown" }] }])))
  })

  it("cleans the item names and maps them through the aliases", () => {
    const decoded = Result.getOrThrow(decodeSimple([record]))
    const [simple] = makeSimpleBreakfasts(decoded, makeAliases({ творог: "творог зернистый" }))
    assert.deepStrictEqual(
      simple?.items.map((item) => item.item),
      ["творог зернистый"]
    )
  })

  it.live("loads the file, and an absent file is an empty list", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* loadSimpleBreakfasts(), [])
        yield* writeFiles(root, {
          "config/simple-breakfasts.json": JSON.stringify([record]),
          "config/household.json": JSON.stringify({ breakfastExtraIds: [7] }),
        })
        const loaded = yield* loadSimpleBreakfasts(makeAliases({ творог: "творог зернистый" }))
        assert.deepStrictEqual(
          loaded.map((simple) => simple.items[0]?.item),
          ["творог зернистый"]
        )
        const extras = yield* loadCatalogueExtras()
        assert.deepStrictEqual(extras.breakfastExtraIds?.map(Number), [7])
        assert.strictEqual(extras.simpleBreakfasts?.length, 1)
      })
    )
  )

  it.live("fails with a ConfigError for an invalid file", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* writeFiles(root, {
          "config/simple-breakfasts.json": JSON.stringify([record, record]),
        })
        const error = yield* Effect.flip(loadSimpleBreakfasts())
        assert.strictEqual(error._tag, "ConfigError")
        assert.include(error.message, "simple-breakfasts.json")
      })
    )
  )

  it("the committed file decodes and every item has an entry in the protein table", () => {
    const simple = Schema.decodeUnknownSync(SimpleBreakfastsJson)(
      readFileSync(new URL("../config/simple-breakfasts.json", import.meta.url), "utf8")
    )
    assert.isAbove(simple.length, 0)
    const aliases = makeAliases(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(
        readFileSync(new URL("../config/item-aliases.json", import.meta.url), "utf8")
      )
    )
    const table = makeProteinTable(
      Schema.decodeUnknownSync(ItemProteinJson)(
        readFileSync(new URL("../config/item-protein.json", import.meta.url), "utf8")
      ),
      aliases
    )
    const catalogue = catalogueOf([], aliases, table, makeSimpleBreakfasts(simple, aliases))
    assert.deepStrictEqual(missingProteinItems(catalogue), [])
    for (const breakfast of catalogue.simpleBreakfasts) {
      assert.isAtLeast(simpleProtein(breakfast, table).grams, 10, breakfast.id)
    }
  })
})

describe("simpleProtein (spec P7.2.3)", () => {
  const table = makeProteinTable({ "греческий йогурт": 9, мед: 0.3, хлеб: 8, брынза: 18 }, new Map())

  it("gives the protein of the amounts per portion", () => {
    // 200 g × 9 / 100 + 15 g × 0,3 / 100 = 18,045 g. Honey is not protein-relevant (category sweet, 0.3 g/100 g): the coverage stays 1.
    assert.deepStrictEqual(simpleProtein(YOGURT, table), {
      grams: 18,
      coverage: 1,
    })
  })

  it("lowers the coverage for a protein item without a table entry", () => {
    assert.deepStrictEqual(simpleProtein(BRYNZA, makeProteinTable({ хлеб: 8 }, new Map())), {
      grams: 3.2,
      coverage: 0.5,
    })
  })

  it("lists the items of simple breakfasts that the table misses", () => {
    const catalogue = catalogueOf([], new Map(), table, [YOGURT, BRYNZA])
    assert.deepStrictEqual(missingProteinItems(catalogue), [])
    assert.deepStrictEqual(missingProteinItems(catalogueOf([], new Map(), makeProteinTable({}, new Map()), [YOGURT])), [
      "греческий йогурт",
      "мед",
    ])
  })
})

describe("shoppingList: fresh dishes and simple breakfasts (spec P7.2.2, P7.2.3)", () => {
  const household: Household = {
    ...DEFAULT_HOUSEHOLD,
    meals: ["breakfast", "lunch", "dinner"],
    mealPersons: { breakfast: 2 },
  }
  /** Dish 8 is fresh: 300 g of kefir, 100 g of feta and 200 g of turkey per cooking day. */
  const fresh = entryOf(8, {
    title: "Завтрак Квебек",
    ingredients: [
      inGrams("кефир", 300, { category: "dairy" }),
      inGrams("брынза", 100, { category: "dairy" }),
      inGrams("индейка", 200, { category: "poultry" }),
    ],
  })
  const catalogue = catalogueOf([...baseEntries(), fresh], undefined, undefined, [YOGURT, BRYNZA])
  const plan = planOf({
    cooking: [...BASE_COOKING, { session: "fresh", recipeId: 8, scale: 1.5 }],
    meals: [
      ...BASE_MEALS,
      { day: 0, meal: "breakfast", recipeIds: [8], simpleIds: ["yogurt"] },
      { day: 1, meal: "breakfast", recipeIds: [8], simpleIds: ["yogurt"] },
      { day: 2, meal: "breakfast", recipeIds: [8], simpleIds: [] },
      { day: 3, meal: "breakfast", recipeIds: [], simpleIds: ["brynza"] },
      { day: 4, meal: "breakfast", recipeIds: [], simpleIds: ["brynza"] },
    ],
  })
  const list = shoppingList(plan, catalogue, household)
  const itemOf = (name: string) => list.buy.flatMap((group) => group.items).find((item) => item.item === name)

  it("multiplies a fresh dish by the scale and by the number of days it is eaten", () => {
    // 300 g × 1,5 × 3 days.
    assert.deepStrictEqual(itemOf("кефир")?.amounts, [{ unit: "g", value: 1350 }])
  })

  it("multiplies a simple breakfast by the persons of each slot", () => {
    // 200 g × 2 persons × 2 days.
    assert.deepStrictEqual(itemOf("греческий йогурт")?.amounts, [{ unit: "g", value: 800 }])
    assert.deepStrictEqual(itemOf("греческий йогурт")?.simpleIds, ["yogurt"])
    assert.deepStrictEqual(itemOf("греческий йогурт")?.recipeIds, [])
  })

  it("adds a product of a simple breakfast to the same product of a recipe and names both", () => {
    // Fresh: 100 g × 1,5 × 3 = 450 g. Simple: 30 g × 2 persons × 2 days = 120 g. Together 570 g.
    const feta = itemOf("брынза")
    assert.deepStrictEqual(feta?.amounts, [{ unit: "g", value: 570 }])
    assert.deepStrictEqual(feta?.recipeIds.map(Number), [8])
    assert.deepStrictEqual(feta?.simpleIds, ["brynza"])
  })

  it("puts a pantry item of a simple breakfast in check_at_home", () => {
    const honey = list.check_at_home.find((item) => item.item === "мед")
    assert.deepStrictEqual(honey?.amounts, [{ unit: "g", value: 60 }])
    assert.deepStrictEqual(honey?.simpleIds, ["yogurt"])
  })

  it("gives no freeze action for a fresh dish", () => {
    assert.isUndefined(list.actions.find((action) => action.item === "индейка"))
    // The raw chicken of session B (day 4) still gets its action.
    assert.isAbove(list.actions.length, 0)
  })

  it("lists the fresh dish and the simple breakfasts", () => {
    const dish = list.dishes.find((item) => item.recipeId === 8)
    assert.deepStrictEqual(
      {
        session: dish?.session,
        sessionDay: dish?.sessionDay,
        freshDays: dish?.freshDays,
        scale: dish?.scale,
      },
      { session: "fresh", sessionDay: null, freshDays: [0, 1, 2], scale: 1.5 }
    )
    assert.strictEqual(list.dishes.at(-1)?.recipeId, 8)
    assert.deepStrictEqual(list.simpleBreakfasts, [
      { id: "brynza", title: "Брынза с хлебом", portions: 4, days: [3, 4] },
      { id: "yogurt", title: "Йогурт с бананом", portions: 4, days: [0, 1] },
    ])
  })

  it("lists an unknown simple breakfast and adds nothing for it", () => {
    const unknown = shoppingList(
      planOf({
        cooking: BASE_COOKING,
        meals: [...BASE_MEALS, { day: 0, meal: "breakfast", recipeIds: [], simpleIds: ["nope"] }],
      }),
      baseCatalogue(),
      household
    )
    assert.deepStrictEqual(unknown.unknownSimpleIds, ["nope"])
    assert.deepStrictEqual(unknown.simpleBreakfasts, [])
  })

  it("a fresh dish in no slot adds nothing", () => {
    const never = shoppingList(
      planOf({
        cooking: [...BASE_COOKING, { session: "fresh", recipeId: 8 }],
        meals: BASE_MEALS,
      }),
      catalogue,
      household
    )
    assert.isUndefined(never.buy.flatMap((group) => group.items).find((item) => item.item === "кефир"))
  })

  it("leaves a week without breakfast as before: no simple breakfast, the same session dishes", () => {
    const old = shoppingList(planOf({ cooking: BASE_COOKING, meals: BASE_MEALS }), baseCatalogue(), DEFAULT_HOUSEHOLD)
    assert.deepStrictEqual(old.simpleBreakfasts, [])
    assert.deepStrictEqual(old.unknownSimpleIds, [])
    assert.isTrue(old.dishes.every((dish) => dish.sessionDay !== null && dish.freshDays.length === 0))
    assert.isTrue(old.buy.flatMap((group) => group.items).every((item) => item.simpleIds.length === 0))
  })
})
