import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { makeAliases } from "../src/planner/items.ts"
import { DEFAULT_LIMIT, MAX_LIMIT, SearchQuery, searchRecipes } from "../src/planner/search.ts"
import { catalogueOf, entryOf, ing, inGrams } from "./support/planner.ts"
import type { DishOptions } from "./support/planner.ts"
import { id } from "./support/enrich.ts"

const aliases = makeAliases({ картошка: "картофель" })

const dishes: Readonly<Record<number, DishOptions>> = {
  1: {
    title: "Суп Альфа",
    commentsCount: 50,
    enrichment: { dishType: "soup", proteinFamilies: ["chicken"], vegetarian: false, activeMinutes: 20, totalMinutes: 50, equipment: ["hob"] },
    ingredients: [
      inGrams("Куриное филе", 500, { category: "poultry" }),
      inGrams("картошка", 400, { category: "vegetable" }),
      ing("лук репчатый", { category: "vegetable" }),
      ing("соль", { pantry: true }),
      ing("укроп", { optional: true, category: "herb" })
    ]
  },
  2: {
    title: "Рагу Браво",
    commentsCount: 10,
    enrichment: {
      dishType: "main", proteinFamilies: ["pork"], vegetarian: false, heat: 2, activeMinutes: 40, totalMinutes: 90, difficulty: 2,
      equipment: ["hob", "oven"]
    },
    ingredients: [inGrams("свинина", 600), ing("морковь"), ing("лук репчатый")]
  },
  3: {
    title: "Плов Чарли",
    commentsCount: 80,
    enrichment: { dishType: "main", vegetarian: true, difficulty: 2, activeMinutes: 30, totalMinutes: 60, equipment: ["hob"] },
    ingredients: [inGrams("рис", 300), ing("морковь"), ing("лук репчатый")]
  },
  4: {
    title: "Салат Дельта",
    commentsCount: 5,
    enrichment: { dishType: "salad", mealFit: "side_only", vegetarian: true, activeMinutes: 10, totalMinutes: 10, equipment: [] },
    ingredients: [ing("огурцы"), ing("помидоры"), ing("укроп"), ing("мёд")]
  },
  5: {
    title: "Запеканка Эхо",
    commentsCount: null,
    enrichment: { dishType: "savory_bake", mealFit: "needs_side", vegetarian: true, activeMinutes: 15, totalMinutes: 60, equipment: ["oven", "mixer"], heat: 1 },
    ingredients: [inGrams("творог", 500), ing("яйца"), ing("луковица")]
  },
  6: {
    title: "Уха Фокстрот",
    commentsCount: 50,
    enrichment: { dishType: "soup", proteinFamilies: ["fish"], vegetarian: false, activeMinutes: 25, totalMinutes: 55, equipment: ["hob"] },
    ingredients: [inGrams("окунь", 700, { category: "fish" }), ing("картофель"), ing("лук репчатый")]
  }
}

const catalogue = catalogueOf(
  Object.entries(dishes).map(([key, options]) => entryOf(Number(key), { ...options, aliases })),
  aliases
)

const found = (query: SearchQuery): ReadonlyArray<number> => searchRecipes(catalogue, query).map((row) => Number(row.id))

describe("searchRecipes: sort and limit", () => {
  it("sorts by comments, most first, and by ID for a tie (a missing count is 0)", () => {
    assert.deepStrictEqual(found({}), [3, 1, 6, 2, 4, 5])
    assert.deepStrictEqual(found({ sort: "popular" }), [3, 1, 6, 2, 4, 5])
  })

  it("sorts by the number of items to buy, fewest first, then by comments", () => {
    // Items to buy: 1 has 3 (the salt is pantry, the dill is optional), 2 has 3, 3 has 3, 4 has 4, 5 has 3, 6 has 3.
    assert.deepStrictEqual(searchRecipes(catalogue, { sort: "fewest_items" }).map((row) => [Number(row.id), row.buyItems.length]), [
      [3, 3], [1, 3], [6, 3], [2, 3], [5, 3], [4, 4]
    ])
  })

  it("cuts the result at limit, with 20 as the default and 100 as the maximum", () => {
    assert.deepStrictEqual(found({ limit: 2 }), [3, 1])
    const many = catalogueOf(Array.from({ length: 130 }, (_, index) => entryOf(index + 1)))
    assert.strictEqual(searchRecipes(many, {}).length, DEFAULT_LIMIT)
    assert.strictEqual(searchRecipes(many, { limit: 100 }).length, MAX_LIMIT)
    assert.strictEqual(searchRecipes(many, { limit: 500 }).length, MAX_LIMIT)
    assert.strictEqual(searchRecipes(many, { limit: 0 }).length, 1)
  })

  it("validates limit and sort in the schema", () => {
    const decode = Schema.decodeUnknownResult(SearchQuery)
    assert.isTrue(Result.isSuccess(decode({})))
    assert.isTrue(Result.isSuccess(decode({ limit: 100, sort: "fewest_items", text: "суп" })))
    assert.isTrue(Result.isFailure(decode({ limit: 101 })))
    assert.isTrue(Result.isFailure(decode({ limit: 0 })))
    assert.isTrue(Result.isFailure(decode({ limit: 2.5 })))
    assert.isTrue(Result.isFailure(decode({ sort: "newest" })))
    assert.isTrue(Result.isFailure(decode({ proteinFamilies: ["dragon"] })))
  })
})

describe("searchRecipes: text", () => {
  it("matches a word of 4 letters or more by a common prefix of 4 letters or more", () => {
    // "курица" and "куриное" share "кури".
    assert.deepStrictEqual(found({ text: "курица" }), [1])
    // "картошка" and "картофель" share "карто". The alias also turned "картошка" into "картофель".
    assert.deepStrictEqual(found({ text: "картошка" }), [1, 6])
    assert.deepStrictEqual(found({ text: "АЛЬФА" }), [1])
    assert.deepStrictEqual(found({ text: "окуня" }), [6])
  })

  it("does not match a word that shares fewer than 4 letters", () => {
    assert.deepStrictEqual(found({ text: "курник" }), [])
    assert.deepStrictEqual(found({ text: "свиной" }), [2])
  })

  it("needs a full match for a word shorter than 4 letters", () => {
    // "лук" is a word of the item "лук репчатый" in 4 dishes, but not a prefix of "луковица".
    assert.deepStrictEqual(found({ text: "лук" }), [3, 1, 6, 2])
    assert.deepStrictEqual(found({ text: "суп" }), [1])
    assert.deepStrictEqual(found({ text: "су" }), [])
  })

  it("needs every word to match", () => {
    assert.deepStrictEqual(found({ text: "суп курица" }), [1])
    assert.deepStrictEqual(found({ text: "суп свинина" }), [])
    assert.deepStrictEqual(found({ text: "морковь лук" }), [3, 2])
  })

  it("treats ё as е and ignores case and punctuation", () => {
    assert.deepStrictEqual(found({ text: "Мёд" }), [4])
    assert.deepStrictEqual(found({ text: "мед" }), [4])
    assert.deepStrictEqual(found({ text: "  суп, курица!  " }), [1])
  })

  it("does not filter on an empty text", () => {
    assert.strictEqual(found({ text: "" }).length, 6)
    assert.strictEqual(found({ text: "  ,  " }).length, 6)
  })
})

describe("searchRecipes: filters", () => {
  it("proteinFamilies: any of; an empty list sets no filter", () => {
    assert.deepStrictEqual(found({ proteinFamilies: ["pork", "fish"] }), [6, 2])
    assert.deepStrictEqual(found({ proteinFamilies: ["chicken"] }), [1])
    assert.strictEqual(found({ proteinFamilies: [] }).length, 6)
  })

  it("vegetarian: true or false", () => {
    assert.deepStrictEqual(found({ vegetarian: true }), [3, 4, 5])
    assert.deepStrictEqual(found({ vegetarian: false }), [1, 6, 2])
  })

  it("dishTypes and mealFits: any of", () => {
    assert.deepStrictEqual(found({ dishTypes: ["soup"] }), [1, 6])
    assert.deepStrictEqual(found({ dishTypes: ["soup", "salad"] }), [1, 6, 4])
    assert.deepStrictEqual(found({ mealFits: ["side_only", "needs_side"] }), [4, 5])
    assert.deepStrictEqual(found({ mealFits: ["full_meal"], dishTypes: ["main"] }), [3, 2])
  })

  it("maxActiveMinutes and maxTotalMinutes include the limit", () => {
    assert.deepStrictEqual(found({ maxActiveMinutes: 20 }), [1, 4, 5])
    assert.deepStrictEqual(found({ maxActiveMinutes: 19 }), [4, 5])
    assert.deepStrictEqual(found({ maxTotalMinutes: 55 }), [1, 6, 4])
    assert.deepStrictEqual(found({ maxTotalMinutes: 9 }), [])
  })

  it("maxHeat and maxDifficulty include the limit", () => {
    assert.deepStrictEqual(found({ maxHeat: 0 }), [3, 1, 6, 4])
    assert.deepStrictEqual(found({ maxHeat: 1 }), [3, 1, 6, 4, 5])
    assert.deepStrictEqual(found({ maxDifficulty: 1 }), [1, 6, 4, 5])
    assert.deepStrictEqual(found({ maxDifficulty: 2 }), [3, 1, 6, 2, 4, 5])
  })

  it("requiresOnly: the equipment of the recipe is a subset of the list", () => {
    assert.deepStrictEqual(found({ requiresOnly: ["hob"] }), [3, 1, 6, 4])
    assert.deepStrictEqual(found({ requiresOnly: ["hob", "oven"] }), [3, 1, 6, 2, 4])
    assert.deepStrictEqual(found({ requiresOnly: ["oven", "mixer"] }), [4, 5])
    assert.deepStrictEqual(found({ requiresOnly: [] }), [4])
  })

  it("includesItems: all of, with the names normalised like the items of the catalogue", () => {
    assert.deepStrictEqual(found({ includesItems: ["Картошка", "лук репчатый"] }), [1, 6])
    assert.deepStrictEqual(found({ includesItems: ["картофель", "куриное филе"] }), [1])
    assert.deepStrictEqual(found({ includesItems: ["морковь", "рис"] }), [3])
    assert.deepStrictEqual(found({ includesItems: ["соль"] }), [1])
    assert.deepStrictEqual(found({ includesItems: ["морковь", "окунь"] }), [])
  })

  it("excludeIds", () => {
    assert.deepStrictEqual(found({ excludeIds: [id(3), id(1)] }), [6, 2, 4, 5])
  })

  it("combines the filters", () => {
    assert.deepStrictEqual(found({ vegetarian: false, maxHeat: 1, dishTypes: ["soup"], text: "картофель" }), [1, 6])
    assert.deepStrictEqual(found({ vegetarian: false, maxHeat: 1, proteinFamilies: ["pork"] }), [])
  })
})

describe("searchRecipes: the row", () => {
  const row = searchRecipes(catalogue, { text: "курица" })[0]

  it("has the compact fields of spec P4.2.4 and nothing more", () => {
    assert.deepStrictEqual(Object.keys(row ?? {}).sort(), [
      "activeMinutes", "buyItems", "commentsCount", "difficulty", "dishType", "freezable", "fridgeDays", "heat", "id",
      "longWaitHours", "mealFit", "proteinFamilies", "reheats", "servings", "sideHint", "title", "totalMinutes", "url",
      "vegetarian"
    ])
  })

  it("has the facts of the dish", () => {
    assert.strictEqual(row?.title, "Суп Альфа")
    assert.strictEqual(row?.dishType, "soup")
    assert.deepStrictEqual(row?.proteinFamilies, ["chicken"])
    assert.deepStrictEqual(row?.servings, { min: 4, max: 4 })
    assert.strictEqual(row?.commentsCount, 50)
    assert.strictEqual(row?.url, "https://www.say7.info/cook/recipe/1-Test.html")
  })

  it("lists the normalised items to buy, sorted: no pantry and no optional items", () => {
    assert.deepStrictEqual(row?.buyItems, ["картофель", "куриное филе", "лук репчатый"])
  })
})
