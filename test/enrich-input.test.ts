import { assert, describe, it } from "@effect/vitest"
import {
  allLines,
  buildModelInput,
  canonicalJson,
  computeInputHash,
  lineCount,
  modelInputText,
  numberGroups
} from "../src/enrich/input.ts"
import { parsedRecipe, SALADS } from "./support/enrich.ts"

const twoGroups = {
  ...parsedRecipe(5, { title: "Тест" }),
  ingredientGroups: [
    { title: "Тесто", items: ["200 г муки", "1 яйцо"] },
    { title: null, items: ["соль"] },
    { title: "Начинка", items: ["300 г капусты", "лук", "перец"] }
  ]
}

describe("numberGroups", () => {
  it("counts the lines from 0 over all groups", () => {
    const groups = numberGroups(twoGroups.ingredientGroups)
    assert.deepStrictEqual(
      groups.map((group) => group.lines.map((line) => line.line)),
      [[0, 1], [2], [3, 4, 5]]
    )
    assert.deepStrictEqual(groups.map((group) => group.title), ["Тесто", null, "Начинка"])
  })

  it("keeps the text of each line", () => {
    const lines = numberGroups(twoGroups.ingredientGroups).flatMap((group) => group.lines)
    assert.deepStrictEqual(lines.map((line) => line.text), ["200 г муки", "1 яйцо", "соль", "300 г капусты", "лук", "перец"])
  })

  it("accepts an empty list and an empty group", () => {
    assert.deepStrictEqual(numberGroups([]), [])
    assert.deepStrictEqual(numberGroups([{ title: "Пусто", items: [] }, { title: null, items: ["вода"] }]), [
      { title: "Пусто", lines: [] },
      { title: null, lines: [{ line: 0, text: "вода" }] }
    ])
  })
})

describe("buildModelInput", () => {
  const input = buildModelInput(twoGroups)

  it("has the 7 fields of the spec P3.3 and no other", () => {
    assert.deepStrictEqual(Object.keys(input).toSorted(), [
      "categories",
      "ingredientGroups",
      "intro",
      "servingsText",
      "steps",
      "title",
      "yieldText"
    ])
  })

  it("does not pass comments, dates, similar recipes, parsed servings or the URL", () => {
    const text = modelInputText(input)
    for (const name of ["commentsCount", "addedAt", "similarIds", "sourceSha256", "durations", "longWait", "url"]) {
      assert.notInclude(text, name)
    }
    assert.notInclude(text, twoGroups.url)
  })

  it("passes category names, not IDs", () => {
    assert.deepStrictEqual(buildModelInput(parsedRecipe(1, { categories: [SALADS] })).categories, ["Салаты"])
  })

  it("counts and lists the lines", () => {
    assert.strictEqual(lineCount(input), 6)
    assert.deepStrictEqual(allLines(input).map((line) => line.line), [0, 1, 2, 3, 4, 5])
  })

  it("counts 0 lines for a recipe without ingredients", () => {
    const empty = { ...twoGroups, ingredientGroups: [] }
    assert.strictEqual(lineCount(buildModelInput(empty)), 0)
  })
})

describe("canonicalJson", () => {
  it("sorts the keys of every object and writes no white space", () => {
    assert.strictEqual(canonicalJson({ b: 1, a: { d: [3, { z: null, y: true }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}')
  })

  it("gives the same text for any key order", () => {
    assert.strictEqual(canonicalJson({ a: 1, b: 2, c: [{ x: 1, y: 2 }] }), canonicalJson({ c: [{ y: 2, x: 1 }], b: 2, a: 1 }))
  })

  it("keeps the order of an array", () => {
    assert.notStrictEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
  })

  it("keeps Cyrillic letters and escapes quotes", () => {
    assert.strictEqual(canonicalJson({ "ключ": 'ё "x"' }), '{"ключ":"ё \\"x\\""}')
  })

  it("writes scalars", () => {
    assert.strictEqual(canonicalJson(null), "null")
    assert.strictEqual(canonicalJson(1.5), "1.5")
    assert.strictEqual(canonicalJson(false), "false")
    assert.strictEqual(canonicalJson([]), "[]")
    assert.strictEqual(canonicalJson({}), "{}")
  })
})

describe("computeInputHash", () => {
  const input = buildModelInput(twoGroups)
  const base = { input, promptVersion: 1, model: "claude-haiku-5-5" } as const

  it("is a SHA-256 in lower case hexadecimal", () => {
    assert.match(computeInputHash(base), /^[0-9a-f]{64}$/)
  })

  it("is the same for the same input", () => {
    assert.strictEqual(computeInputHash(base), computeInputHash({ ...base, input: buildModelInput(twoGroups) }))
  })

  it("changes with the model, the prompt version and the input (spec A8)", () => {
    const hashes = new Set([
      computeInputHash(base),
      computeInputHash({ ...base, model: "claude-sonnet-5-5" }),
      computeInputHash({ ...base, promptVersion: 2 }),
      computeInputHash({ ...base, input: { ...input, title: "Другое" } }),
      computeInputHash({ ...base, input: { ...input, steps: [...input.steps, "Подавать."] } })
    ])
    assert.strictEqual(hashes.size, 5)
  })

  it("does not change with fields that the model does not see", () => {
    const changed = { ...twoGroups, commentsCount: 99, addedAt: "2025-05-05", sourceSha256: "c".repeat(64), similarIds: [] }
    assert.strictEqual(computeInputHash({ ...base, input: buildModelInput(changed) }), computeInputHash(base))
  })
})
