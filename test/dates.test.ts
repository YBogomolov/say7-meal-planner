import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { parseAddedAt, parseRuDate } from "../src/parser/dates.ts"

describe("parseRuDate", () => {
  it("turns DD.MM.YYYY into YYYY-MM-DD", () => {
    assert.strictEqual(Option.getOrNull(parseRuDate("05.12.2023")), "2023-12-05")
    assert.strictEqual(Option.getOrNull(parseRuDate("1.2.2006")), "2006-02-01")
  })

  it("accepts the leap day of a leap year only", () => {
    assert.strictEqual(Option.getOrNull(parseRuDate("29.02.2024")), "2024-02-29")
    assert.isTrue(Option.isNone(parseRuDate("29.02.2023")))
  })

  it("rejects dates that do not exist", () => {
    assert.isTrue(Option.isNone(parseRuDate("31.04.2024")))
    assert.isTrue(Option.isNone(parseRuDate("00.01.2024")))
    assert.isTrue(Option.isNone(parseRuDate("10.13.2024")))
  })

  it("finds the date inside text, and ignores text without a date", () => {
    assert.strictEqual(Option.getOrNull(parseRuDate("Обновлен: 20.10.2025")), "2025-10-20")
    assert.isTrue(Option.isNone(parseRuDate("Обновлен вчера")))
    assert.isTrue(Option.isNone(parseRuDate("1.5 кг")))
  })
})

describe("parseAddedAt", () => {
  it("reads the date after 'Рецепт добавлен:'", () => {
    assert.strictEqual(Option.getOrNull(parseAddedAt("Рецепт добавлен: 05.12.2023 Обновлен: 20.10.2025")), "2023-12-05")
  })

  it("ignores another date in the text", () => {
    assert.isTrue(Option.isNone(parseAddedAt("Обновлен: 20.10.2025")))
  })

  it("gives none when the date after the label does not exist", () => {
    assert.isTrue(Option.isNone(parseAddedAt("Рецепт добавлен: 31.02.2024")))
  })
})
