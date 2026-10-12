import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { ParsedReadError } from "../src/enrich/store.ts"
import { StoreError } from "../src/scraper/store.ts"
import { getRecipeDetails, loadCatalogue, makeCatalogue, toCatalogueEntry } from "../src/planner/catalogue.ts"
import { makeAliases } from "../src/planner/items.ts"
import { DESSERTS, id, SOUPS } from "./support/enrich.ts"
import { enrichedJson, enrichedRecipe, ing, inGrams, parsedJson, withTempDir, writeFiles } from "./support/planner.ts"
import { parsedRecipe } from "./support/enrich.ts"

const FILES = {
  // 1: both files, a dish.
  "data/parsed/1.json": parsedJson(1, { title: "Суп Один", categories: [SOUPS, DESSERTS] }),
  "data/enriched/1.json": enrichedJson(1, {
    ingredients: [inGrams("Лук Репчатый", 100), ing("Соль", { pantry: true })]
  }),
  // 2: no enriched file (a dessert, out of scope).
  "data/parsed/2.json": parsedJson(2),
  // 3: no parsed file.
  "data/enriched/3.json": enrichedJson(3),
  // 4: the enriched file is not valid.
  "data/parsed/4.json": parsedJson(4),
  "data/enriched/4.json": "{\"id\": 4}",
  // 5: the parsed file is not JSON.
  "data/parsed/5.json": "not json",
  "data/enriched/5.json": enrichedJson(5),
  // 6: not a meal.
  "data/parsed/6.json": parsedJson(6),
  "data/enriched/6.json": enrichedJson(6, { enrichment: { mealFit: "not_a_meal", dishType: "sauce" } }),
  // 7: the parsed file holds another recipe.
  "data/parsed/7.json": parsedJson(8),
  "data/enriched/7.json": enrichedJson(7),
  // Files that are no recipes.
  "data/parsed/_report.json": "{}",
  "data/enriched/_report.json": "{}",
  "data/enriched/_batch.json": "{}",
  "data/enriched/9.json.tmp": "{}",
  "data/parsed/notes.txt": "x"
} as const

describe("loadCatalogue", () => {
  it.live("joins the parsed and the enriched file by ID and skips the rest, with the reason", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, FILES)
        const { catalogue, skipped } = yield* loadCatalogue(`${root}/data`)
        assert.deepStrictEqual(catalogue.entries.map((entry) => Number(entry.id)), [1])
        assert.deepStrictEqual(
          skipped.map((entry) => [Number(entry.id), entry.reason]),
          [[2, "no_enriched"], [3, "no_parsed"], [4, "invalid_enriched"], [5, "invalid_parsed"], [6, "not_a_meal"], [7, "invalid_parsed"]]
        )
        assert.isTrue(skipped.every((entry) => entry.message.length > 10))
        assert.include(skipped.find((entry) => entry.reason === "invalid_parsed" && entry.id === id(7))?.message ?? "", "содержит рецепт 8")
      })
    ))

  it.live("builds the entry: facts of the page, the full enrichment, normalised items, no texts", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, FILES)
        const { catalogue } = yield* loadCatalogue(`${root}/data`)
        const entry = catalogue.byId.get(id(1))
        assert.strictEqual(entry?.title, "Суп Один")
        assert.strictEqual(entry?.url, "https://www.say7.info/cook/recipe/1-Test.html")
        assert.deepStrictEqual(entry?.primaryCategory, { id: 47, name: "Первые блюда" })
        assert.strictEqual(entry?.commentsCount, 3)
        assert.strictEqual(entry?.enrichment.mealFit, "full_meal")
        assert.deepStrictEqual(entry?.enrichment.servings, { min: 4, max: 4, source: "page" })
        assert.deepStrictEqual(entry?.enrichment.ingredients.map((item) => [item.item, item.rawItem, item.pantry]), [
          ["лук репчатый", "Лук Репчатый", false],
          ["соль", "Соль", true]
        ])
        const text = JSON.stringify(entry)
        assert.notInclude(text, "Простое блюдо для теста.")
        assert.notInclude(text, "Нарезать.")
        assert.notProperty(entry ?? {}, "intro")
        assert.notProperty(entry ?? {}, "steps")
      })
    ))

  it.live("applies the alias map to the item names", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, FILES)
        const aliases = makeAliases({ "лук репчатый": "лук" })
        const { catalogue } = yield* loadCatalogue(`${root}/data`, aliases)
        assert.deepStrictEqual(catalogue.byId.get(id(1))?.enrichment.ingredients.map((item) => item.item), ["лук", "соль"])
        assert.strictEqual(catalogue.aliases, aliases)
      })
    ))

  it.live("sorts the entries by ID and loads many files", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        const numbers = [30, 4, 1000, 17, 2, 250]
        yield* writeFiles(
          root,
          Object.fromEntries(numbers.flatMap((n) => [[`data/parsed/${n}.json`, parsedJson(n)], [`data/enriched/${n}.json`, enrichedJson(n)]]))
        )
        const { catalogue, skipped } = yield* loadCatalogue(`${root}/data`)
        assert.deepStrictEqual(catalogue.entries.map((entry) => Number(entry.id)), [2, 4, 17, 30, 250, 1000])
        assert.deepStrictEqual(skipped, [])
      })
    ))

  it.live("fails if the enriched directory is missing, and gives an empty catalogue if it is empty", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, { "data/parsed/1.json": parsedJson(1), "data/parsed/2.json": parsedJson(2) })
        const missing = yield* Effect.flip(loadCatalogue(`${root}/data`))
        assert.instanceOf(missing, StoreError)
        assert.include(missing.message, "npm run enrich")
        yield* writeFiles(root, { "data/enriched/.keep": "" })
        const { catalogue, skipped } = yield* loadCatalogue(`${root}/data`)
        assert.strictEqual(catalogue.entries.length, 0)
        assert.deepStrictEqual(skipped.map((entry) => entry.reason), ["no_enriched", "no_enriched"])
      })
    ))

  it.live("fails with a StoreError that names the command if the parsed directory is missing", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, { "data/enriched/1.json": enrichedJson(1) })
        const error = yield* Effect.flip(loadCatalogue(`${root}/data`))
        assert.instanceOf(error, StoreError)
        assert.include(error.message, "npm run parse")
      })
    ))
})

describe("getRecipeDetails", () => {
  it.live("reads the intro, the ingredient lines and the steps from the parsed file", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, { "data/parsed/5.json": parsedJson(5, { title: "Суп Пять", lines: ["200 г моркови", "соль"] }) })
        const details = yield* getRecipeDetails(`${root}/data`, id(5))
        assert.strictEqual(details.title, "Суп Пять")
        assert.deepStrictEqual(details.intro, ["Простое блюдо для теста."])
        assert.deepStrictEqual(details.steps, ["Нарезать.", "Варить 20 минут."])
        assert.deepStrictEqual(details.ingredientGroups, [{ title: null, items: ["200 г моркови", "соль"] }])
        assert.strictEqual(details.servingsText, "4 порции")
      })
    ))

  it.live("fails with ParsedReadError for a missing or an invalid file", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, { "data/parsed/6.json": "{}" })
        const missing = yield* Effect.flip(getRecipeDetails(`${root}/data`, id(5)))
        assert.instanceOf(missing, ParsedReadError)
        assert.strictEqual(missing.id, 5)
        const invalid = yield* Effect.flip(getRecipeDetails(`${root}/data`, id(6)))
        assert.instanceOf(invalid, ParsedReadError)
      })
    ))
})

describe("toCatalogueEntry and makeCatalogue", () => {
  it("takes the first category as the primary category, and null if there is none", () => {
    const parsed = parsedRecipe(1, { categories: [DESSERTS, SOUPS] })
    assert.deepStrictEqual(toCatalogueEntry(parsed, enrichedRecipe(1), new Map()).primaryCategory, { id: 39, name: "Десерты" })
    assert.isNull(toCatalogueEntry({ ...parsed, categories: [] }, enrichedRecipe(1), new Map()).primaryCategory)
  })

  it("keeps a missing comment count as null", () => {
    assert.isNull(toCatalogueEntry({ ...parsedRecipe(1), commentsCount: null }, enrichedRecipe(1), new Map()).commentsCount)
  })

  it("makes a catalogue with a lookup by ID, sorted", () => {
    const entries = [3, 1, 2].map((n) => toCatalogueEntry(parsedRecipe(n), enrichedRecipe(n), new Map()))
    const catalogue = makeCatalogue(entries)
    assert.deepStrictEqual(catalogue.entries.map((entry) => Number(entry.id)), [1, 2, 3])
    assert.strictEqual(catalogue.byId.get(id(2))?.id, 2)
    assert.isUndefined(catalogue.byId.get(id(4)))
  })
})
