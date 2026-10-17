import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { DEFAULT_HOUSEHOLD } from "../src/domain/household.ts"
import { WeekPlanJson } from "../src/domain/week-plan.ts"
import { evaluatePlan } from "../src/planner/evaluate.ts"
import { decodePlan, decodePlanJson, loadHistory, PlanInvalidError, savePlan } from "../src/planner/plans.ts"
import {
  baseCatalogue,
  basePlan,
  BASE_COOKING,
  BASE_MEALS,
  planOf,
  withTempDir,
  writeFiles,
} from "./support/planner.ts"

describe("savePlan", () => {
  it.live("writes data/plans/<weekStart>.json atomically and returns the path", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const saved = yield* savePlan(`${root}/data`, basePlan())
        assert.strictEqual(saved.path, `${root}/data/plans/2026-10-17.json`)
        assert.deepStrictEqual(saved.plan, basePlan())
        const text = yield* fs.readFileString(saved.path)
        assert.isTrue(text.endsWith("}\n"))
        assert.include(text, '\n  "weekStart": "2026-10-17"')
        assert.deepStrictEqual(Schema.decodeUnknownSync(WeekPlanJson)(text), basePlan())
        assert.deepStrictEqual(yield* fs.readDirectory(`${root}/data/plans`), ["2026-10-17.json"])
      })
    )
  )

  it.live("replaces the plan of the same week", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* savePlan(`${root}/data`, basePlan())
        yield* savePlan(`${root}/data`, {
          ...basePlan(),
          notes: "Вторая версия",
        })
        const names = yield* fs.readDirectory(`${root}/data/plans`)
        assert.deepStrictEqual(names, ["2026-10-17.json"])
        const { plans } = yield* loadHistory(`${root}/data`)
        assert.deepStrictEqual(
          plans.map((plan) => plan.notes),
          ["Вторая версия"]
        )
      })
    )
  )

  it.live("decodes only: a plan that breaks the rules of the household is saved", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const broken = planOf({
          cooking: [{ session: "A", recipeId: 999 }],
          meals: [{ day: 0, meal: "lunch", recipeIds: [5] }],
        })
        const saved = yield* savePlan(`${root}/data`, broken)
        assert.deepStrictEqual(saved.plan, broken)
      })
    )
  )

  it.live("accepts the input of a caller as plain JSON data", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const saved = yield* savePlan(`${root}/data`, {
          weekStart: "2026-11-07",
          cooking: [{ session: "B", recipeId: 3, scale: 2 }],
          meals: [{ day: 4, meal: "dinner", recipeIds: [3] }],
        })
        assert.strictEqual(saved.plan.notes, null)
        assert.strictEqual(saved.path, `${root}/data/plans/2026-11-07.json`)
      })
    )
  )

  it.live("rejects an invalid plan with PlanInvalidError, writes nothing, and names every problem", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const error = yield* Effect.flip(
          savePlan(`${root}/data`, {
            weekStart: "../../etc/passwd",
            cooking: [{ session: "Q", recipeId: 1, scale: 9 }],
            meals: [],
          })
        )
        assert.instanceOf(error, PlanInvalidError)
        for (const field of ["weekStart", "session", "scale"]) {
          assert.include(error.message, field)
        }
        assert.isFalse(yield* fs.exists(`${root}/data/plans`))
        assert.instanceOf(yield* Effect.flip(savePlan(`${root}/data`, "text")), PlanInvalidError)
        assert.instanceOf(yield* Effect.flip(savePlan(`${root}/data`, null)), PlanInvalidError)
      })
    )
  )
})

describe("loadHistory", () => {
  it.live("gives an empty history if data/plans does not exist", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* loadHistory(`${root}/data`), {
          plans: [],
          skipped: [],
        })
      })
    )
  )

  it.live("reads all plans, oldest week first, and skips the files that are no plans", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* savePlan(`${root}/data`, planOf({ weekStart: "2026-10-17", cooking: [], meals: [] }))
        yield* savePlan(`${root}/data`, planOf({ weekStart: "2026-09-26", cooking: [], meals: [] }))
        yield* savePlan(
          `${root}/data`,
          planOf({
            weekStart: "2026-10-03",
            cooking: BASE_COOKING.slice(0, 1),
            meals: BASE_MEALS.slice(0, 1),
          })
        )
        yield* writeFiles(root, {
          "data/plans/notes.txt": "x",
          "data/plans/2026-10-10.json.tmp": "{",
          "data/plans/2026-10-10.json": "{",
          "data/plans/2026-10-24.json": JSON.stringify({
            weekStart: "2026-10-31",
            cooking: [],
            meals: [],
            notes: null,
          }),
          "data/plans/2026-11-02.json": JSON.stringify({
            weekStart: "2026-11-02",
            cooking: [{ session: "A", recipeId: 1, scale: 9 }],
            meals: [],
          }),
        })
        const history = yield* loadHistory(`${root}/data`)
        assert.deepStrictEqual(
          history.plans.map((plan) => plan.weekStart),
          ["2026-09-26", "2026-10-03", "2026-10-17"]
        )
        assert.deepStrictEqual(
          history.skipped.map((entry) => entry.file.slice(root.length + 1)),
          ["data/plans/2026-10-10.json", "data/plans/2026-10-24.json", "data/plans/2026-11-02.json"]
        )
        assert.include(history.skipped[1]?.message ?? "", "2026-10-31")
        assert.isTrue(history.skipped.every((entry) => entry.message.length > 10))
      })
    )
  )

  it.live("gives the saved plans to evaluatePlan for recent_repeat", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* savePlan(`${root}/data`, {
          ...basePlan(),
          weekStart: "2026-10-03",
        })
        const { plans } = yield* loadHistory(`${root}/data`)
        const evaluation = evaluatePlan(basePlan(), baseCatalogue(), DEFAULT_HOUSEHOLD, plans)
        assert.strictEqual(evaluation.warnings.filter((issue) => issue.code === "recent_repeat").length, 7)
        assert.isTrue(evaluation.ok)
      })
    )
  )
})

describe("decodePlan and decodePlanJson", () => {
  it.live("decode the value and the text of a plan", () =>
    Effect.gen(function* () {
      const text = Schema.encodeSync(WeekPlanJson)(basePlan())
      assert.deepStrictEqual(yield* decodePlanJson(text), basePlan())
      assert.deepStrictEqual(yield* decodePlan(JSON.parse(text)), basePlan())
    })
  )

  it.live("fail with a Russian message", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodePlanJson("{ not json"))
      assert.instanceOf(error, PlanInvalidError)
      assert.include(error.message, "План не прошёл проверку")
    })
  )
})
