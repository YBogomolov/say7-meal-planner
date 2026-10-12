import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { findServingsText, parseServings } from "../src/parser/servings.ts"

const servings = (text: string) => Option.getOrNull(parseServings(text))

describe("parseServings", () => {
  it.each([
    ["6–8 порций", { min: 6, max: 8 }],
    ["4 порции", { min: 4, max: 4 }],
    ["на 2 порции", { min: 2, max: 2 }],
    ["1 порция", { min: 1, max: 1 }]
  ])("reads %s", (text, expected) => {
    assert.deepStrictEqual(servings(text), expected)
  })

  it.each([
    ["6-8 порций", { min: 6, max: 8 }],
    ["6 — 8 порций", { min: 6, max: 8 }],
    ["6 или 8 порций", { min: 6, max: 8 }],
    ["8–6 порций", { min: 6, max: 8 }],
    ["10 порций", { min: 10, max: 10 }],
    ["Порции: 4", null]
  ])("reads the variant %s", (text, expected) => {
    assert.deepStrictEqual(servings(text), expected)
  })

  it("reads the whole sentence of the page and ignores other numbers", () => {
    assert.deepStrictEqual(
      servings("Из указанного количества ингредиентов получается 6–10 порций (диаметр торта 24 см, высота — 8 см)."),
      { min: 6, max: 10 }
    )
  })

  it("takes the number just before the word, also when other numbers come first", () => {
    assert.deepStrictEqual(servings("Через 20 минут получается 4 порции"), { min: 4, max: 4 })
  })

  it("gives nothing when no whole number stands before the word", () => {
    assert.strictEqual(servings("Я затрудняюсь сказать точно, сколько получается порций, но его много."), null)
    assert.strictEqual(servings("нарезать на порции"), null)
    assert.strictEqual(servings(""), null)
  })

  it("gives nothing for a decimal number or for 0", () => {
    assert.strictEqual(servings("1,5 порции"), null)
    assert.strictEqual(servings("2.5 порции"), null)
    assert.strictEqual(servings("0 порций"), null)
  })

  it("does not read a number that is not followed by the word", () => {
    assert.strictEqual(servings("6–8 штук"), null)
  })
})

const find = (sources: { readonly yieldText?: string; readonly intro?: ReadonlyArray<string>; readonly steps?: ReadonlyArray<string> }) =>
  Option.getOrNull(
    findServingsText({
      yieldText: Option.fromNullishOr(sources.yieldText),
      intro: sources.intro ?? [],
      steps: sources.steps ?? []
    })
  )

describe("findServingsText", () => {
  it("takes the yield text first, if it contains the word", () => {
    assert.strictEqual(
      find({ yieldText: "6–8 порций", intro: ["Получается 4 порции."], steps: ["Разделить на 2 порции."] }),
      "6–8 порций"
    )
  })

  it("keeps the whole yield text", () => {
    assert.strictEqual(
      find({ yieldText: "6–10 порций (диаметр торта 24 см)" }),
      "6–10 порций (диаметр торта 24 см)"
    )
  })

  it("skips a yield in pieces and takes the first intro sentence that contains the word", () => {
    assert.strictEqual(
      find({
        yieldText: "100–110 штук",
        intro: ["Очень вкусно.", "Хорош со сметаной. Хватит на 6–8 порций. Подавать холодным."],
        steps: ["Разделить на 2 порции."]
      }),
      "Хватит на 6–8 порций."
    )
  })

  it("takes the intro before the steps", () => {
    assert.strictEqual(find({ intro: ["Получается 4 порции."], steps: ["Разделить на 2 порции."] }), "Получается 4 порции.")
  })

  it("takes the first step sentence that contains the word when the yield and the intro have none", () => {
    assert.strictEqual(
      find({ yieldText: "10 котлет", intro: ["Простой салат."], steps: ["Нарезать.\nРазложить по порциям."] }),
      "Разложить по порциям."
    )
  })

  it("is not case sensitive", () => {
    assert.strictEqual(find({ intro: ["Порций будет много."] }), "Порций будет много.")
    assert.strictEqual(find({ yieldText: "6 Порций" }), "6 Порций")
  })

  it("gives none when no source has the word", () => {
    assert.isNull(find({ yieldText: "5–7 штук", intro: ["Получается много."], steps: ["Варить."] }))
    assert.isNull(find({}))
  })
})
