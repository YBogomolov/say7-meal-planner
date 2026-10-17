import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import {
  AliasesJson,
  buyItemsOf,
  cleanItemName,
  isBuyIngredient,
  itemsReport,
  makeAliases,
  normaliseItem,
  NO_ALIASES,
} from "../src/planner/items.ts"
import { baseCatalogue, catalogueOf, entryOf, ing, inGrams } from "./support/planner.ts"

describe("normaliseItem", () => {
  it("lower-cases, replaces ё with е, trims and collapses spaces", () => {
    assert.strictEqual(normaliseItem("  Лук   РЕПЧАТЫЙ ", NO_ALIASES), "лук репчатый")
    assert.strictEqual(normaliseItem("Перец чёрный", NO_ALIASES), "перец черный")
    assert.strictEqual(normaliseItem("ЁЖИК", NO_ALIASES), "ежик")
    assert.strictEqual(normaliseItem("сыр твёрдый\tсорт", NO_ALIASES), "сыр твердый сорт")
  })

  it("turns the й of 2 code points (и and the breve) into 1 letter", () => {
    assert.strictEqual(normaliseItem("край", NO_ALIASES), "край")
  })

  it("replaces a variant through the alias map, after the cleaning", () => {
    const aliases = makeAliases({
      "репчатый лук": "лук репчатый",
      Томаты: "помидоры",
    })
    assert.strictEqual(normaliseItem("Репчатый  лук", aliases), "лук репчатый")
    assert.strictEqual(normaliseItem("томаты", aliases), "помидоры")
    assert.strictEqual(normaliseItem("помидоры", aliases), "помидоры")
  })

  it("cleans the keys and the values of the alias map", () => {
    const aliases = makeAliases({
      "  Кинза ": "Кинза (зелень)",
      "Сметана 20%": "сметана",
    })
    assert.strictEqual(normaliseItem("кинза", aliases), "кинза (зелень)")
    assert.strictEqual(normaliseItem("СМЕТАНА 20%", aliases), "сметана")
  })

  it("does not follow a chain of aliases, and ignores empty and identical entries", () => {
    const aliases = makeAliases({ a: "b", b: "c", "": "x", y: "", z: "Z" })
    assert.strictEqual(normaliseItem("a", aliases), "b")
    assert.strictEqual(aliases.size, 2)
  })

  it("does not take the names of Object.prototype for aliases", () => {
    assert.strictEqual(normaliseItem("constructor", NO_ALIASES), "constructor")
    assert.strictEqual(normaliseItem("__proto__", makeAliases({})), "__proto__")
  })

  it("decodes the file item-aliases.json", () => {
    const decoded = Schema.decodeUnknownResult(AliasesJson)('{"a":"b"}')
    assert.deepStrictEqual(Result.getOrThrow(decoded), { a: "b" })
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(AliasesJson)('{"a":1}')))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(AliasesJson)('["a"]')))
  })

  it("cleans a name the same way as normaliseItem without aliases", () => {
    assert.strictEqual(cleanItemName(" Ёлка "), "елка")
  })
})

describe("buy items", () => {
  const entry = entryOf(1, {
    ingredients: [
      ing("Морковь"),
      ing("морковь"),
      ing("Соль", { pantry: true }),
      ing("Укроп", { optional: true }),
      ing("Рис"),
    ],
  })

  it("tells which ingredient is bought", () => {
    assert.deepStrictEqual(entry.enrichment.ingredients.map(isBuyIngredient), [true, true, false, false, true])
  })

  it("lists the normalised buy items of a dish, each once, sorted", () => {
    assert.deepStrictEqual(buyItemsOf(entry.enrichment.ingredients), ["морковь", "рис"])
  })
})

describe("itemsReport", () => {
  it("lists each normalised item with the number of recipes and the raw variants", () => {
    const aliases = makeAliases({ "репчатый лук": "лук репчатый" })
    const catalogue = catalogueOf(
      [
        entryOf(1, {
          aliases,
          ingredients: [inGrams("Лук репчатый", 100), inGrams("Морковь", 100), ing("Соль", { pantry: true })],
        }),
        entryOf(2, {
          aliases,
          ingredients: [inGrams("репчатый лук", 100), inGrams("лук репчатый", 50), inGrams("лук репчатый", 20)],
        }),
        entryOf(3, { aliases, ingredients: [inGrams("Морковь", 100)] }),
      ],
      aliases
    )
    assert.deepStrictEqual(itemsReport(catalogue), [
      {
        item: "лук репчатый",
        recipes: 2,
        variants: ["Лук репчатый", "лук репчатый", "репчатый лук"],
      },
      { item: "морковь", recipes: 2, variants: ["Морковь"] },
      { item: "соль", recipes: 1, variants: ["Соль"] },
    ])
  })

  it("counts a recipe once for an item that it names twice", () => {
    const rows = itemsReport(catalogueOf([entryOf(1, { ingredients: [inGrams("рис", 1), inGrams("рис", 2)] })]))
    assert.deepStrictEqual(rows, [{ item: "рис", recipes: 1, variants: ["рис"] }])
  })

  it("sorts by recipes, most first, then by name", () => {
    const rows = itemsReport(baseCatalogue())
    assert.strictEqual(rows[0]?.item, "лук репчатый")
    assert.strictEqual(rows[0]?.recipes, 3)
    const counts = rows.map((row) => row.recipes)
    assert.deepStrictEqual(
      counts,
      [...counts].sort((a, b) => b - a)
    )
  })

  it("is empty for an empty catalogue", () => {
    assert.deepStrictEqual(itemsReport(catalogueOf([])), [])
  })
})
