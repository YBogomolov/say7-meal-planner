import { assert, describe, it } from "@effect/vitest"
import { Option, Result, Schema } from "effect"
import type { RawIndex, RawIndexEntry } from "../src/domain/raw-index.ts"
import { RecipeId } from "../src/domain/recipe.ts"
import { planParse } from "../src/parser/plan.ts"

const id = (n: number): RecipeId => Result.getOrThrow(Schema.decodeUnknownResult(RecipeId)(n))

const entry = (n: number, status: RawIndexEntry["status"]): RawIndexEntry => ({
  id: id(n),
  url: `https://www.say7.info/cook/recipe/${n}-R.html`,
  lastmod: null,
  fetchedAt: "2026-01-01T00:00:00.000Z",
  status,
  httpStatus: status === "ok" ? 200 : status === "not_found" ? 404 : null,
  bytes: status === "ok" ? 10 : null,
  sha256: status === "ok" ? "f".repeat(64) : null,
  error: status === "error" ? "boom" : null,
})

const index: RawIndex = {
  version: 1,
  entries: {
    "30": entry(30, "ok"),
    "5": entry(5, "ok"),
    "77": entry(77, "not_found"),
    "88": entry(88, "error"),
    "100": entry(100, "ok"),
  },
}

const ids = (...numbers: ReadonlyArray<number>) => Option.some(new Set(numbers.map(id)))

describe("planParse", () => {
  it("takes the entries with status ok, in ascending order of ID", () => {
    const plan = planParse(index, Option.none())
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.toParse, [5, 30, 100])
    assert.deepStrictEqual(plan.unknownIds, [])
    assert.deepStrictEqual(plan.notOkIds, [])
  })

  it("keeps only the requested IDs", () => {
    assert.deepStrictEqual<ReadonlyArray<number>>(planParse(index, ids(100, 5)).toParse, [5, 100])
  })

  it("reports requested IDs that are not in the index", () => {
    const plan = planParse(index, ids(5, 999, 12))
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.toParse, [5])
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.unknownIds, [12, 999])
  })

  it("reports requested IDs whose status is not ok", () => {
    const plan = planParse(index, ids(77, 88, 30))
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.toParse, [30])
    assert.deepStrictEqual<ReadonlyArray<number>>(plan.notOkIds, [77, 88])
    assert.deepStrictEqual(plan.unknownIds, [])
  })

  it("has nothing to parse for an empty index", () => {
    assert.deepStrictEqual(planParse({ version: 1, entries: {} }, Option.none()).toParse, [])
  })
})
