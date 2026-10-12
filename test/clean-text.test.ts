import { assert, describe, it } from "@effect/vitest"
import { cleanLines, cleanText, splitSentences } from "../src/parser/text.ts"

describe("cleanText", () => {
  it("turns the no-break space into a space", () => {
    assert.strictEqual(cleanText("100\u00A0г сахара"), "100 г сахара")
  })

  it("turns the non-breaking hyphen into a hyphen", () => {
    assert.strictEqual(cleanText("Картофель по\u2011деревенски"), "Картофель по-деревенски")
    assert.strictEqual(cleanText("по\u2010деревенски"), "по-деревенски")
  })

  it("collapses white space of every kind and trims", () => {
    assert.strictEqual(cleanText("  Салат \n\t «Цезарь"), "Салат «Цезарь")
    assert.strictEqual(cleanText("a b c\u3000d"), "a b c d")
  })

  it("removes soft hyphens, zero-width characters and the BOM", () => {
    assert.strictEqual(cleanText("ов\u00ADощи\u200B\uFEFF"), "овощи")
  })

  it("keeps dashes, quotes and fractions", () => {
    assert.strictEqual(cleanText("6–8 порций — «Три шоколада» ½ ч.л."), "6–8 порций — «Три шоколада» ½ ч.л.")
  })

  it("gives an empty string for white space only", () => {
    assert.strictEqual(cleanText(" \u00A0\n "), "")
  })
})

describe("cleanLines", () => {
  it("cleans each line and drops empty lines", () => {
    assert.deepStrictEqual(cleanLines(["  a\u00A0b ", "", " \n", "c"]), ["a b", "c"])
  })
})

describe("splitSentences", () => {
  it("splits at a full stop, a question mark and an exclamation mark before a capital letter", () => {
    assert.deepStrictEqual(splitSentences("Очень вкусно! Готовится быстро. Как это? Просто."), [
      "Очень вкусно!",
      "Готовится быстро.",
      "Как это?",
      "Просто."
    ])
  })

  it("ends a sentence at a line break", () => {
    assert.deepStrictEqual(splitSentences("Нагреть\nОстудить"), ["Нагреть", "Остудить"])
  })

  it("does not split inside an abbreviation or a decimal number", () => {
    assert.deepStrictEqual(splitSentences("Взять 1.5 ч.л. соли и т.д. по вкусу."), ["Взять 1.5 ч.л. соли и т.д. по вкусу."])
  })

  it("does not split before a lower-case word", () => {
    assert.deepStrictEqual(splitSentences("Хватит на 4 порции (в т.е. на всех). и ещё"), ["Хватит на 4 порции (в т.е. на всех). и ещё"])
  })

  it("keeps a bracket after the full stop with the next sentence", () => {
    assert.deepStrictEqual(splitSentences("Готово. (Можно подавать.)"), ["Готово.", "(Можно подавать.)"])
  })

  it("gives no sentence for empty text", () => {
    assert.deepStrictEqual(splitSentences("  \n "), [])
  })
})
