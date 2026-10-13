import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { DECODE_OPTIONS, DEFAULT_HOUSEHOLD, Household, HouseholdJson, sessionDay } from "../src/domain/household.ts"
import { PLAN_DECODE_OPTIONS, PLAN_SCALES, WeekPlan } from "../src/domain/week-plan.ts"
import { ConfigError, loadAliases, loadHousehold } from "../src/planner/config.ts"
import { AliasesJson, cleanItemName, normaliseItem } from "../src/planner/items.ts"
import { withTempDir, writeFiles } from "./support/planner.ts"

const decodeHousehold = (input: unknown) => Schema.decodeUnknownResult(Household)(input, DECODE_OPTIONS)

describe("Household", () => {
  it("has the defaults of spec P4.1", () => {
    assert.deepStrictEqual(DEFAULT_HOUSEHOLD, {
      persons: 3,
      days: 7,
      meals: ["lunch", "dinner"],
      sessions: [{ id: "A", dayOffset: 0 }, { id: "B", dayOffset: 4 }],
      shoppingDayOffset: 0,
      maxDaysPerDish: 3,
      maxHeat: 2,
      activeMinutesPerSession: 150,
      longWaitHoursMax: 12,
      equipment: ["hob", "oven", "microwave", "air_fryer", "food_processor", "blender", "immersion_blender", "mixer"],
      fridgeDaysCap: 4,
      rawProteinFridgeDays: 2,
      maxProteinFamilies: 2,
      recentWeeks: 4
    })
  })

  it("is the same as config/household.json, which lists every key", () => {
    const text = readFileSync(new URL("../config/household.json", import.meta.url), "utf8")
    assert.deepStrictEqual(Schema.decodeUnknownSync(HouseholdJson)(text, DECODE_OPTIONS), DEFAULT_HOUSEHOLD)
    assert.deepStrictEqual(Object.keys(JSON.parse(text)).sort(), Object.keys(DEFAULT_HOUSEHOLD).sort())
  })

  it("keeps the given keys and fills the others with the defaults", () => {
    const household = Result.getOrThrow(decodeHousehold({ persons: 4, maxHeat: 1 }))
    assert.strictEqual(household.persons, 4)
    assert.strictEqual(household.maxHeat, 1)
    assert.strictEqual(household.days, 7)
    assert.deepStrictEqual(household.sessions, DEFAULT_HOUSEHOLD.sessions)
  })

  it("rejects a key that it does not know, so that a typo does not pass", () => {
    const result = decodeHousehold({ persns: 4 })
    assert.isTrue(Result.isFailure(result))
    assert.include(Result.isFailure(result) ? result.failure.message : "", "persns")
  })

  it("rejects values outside the model", () => {
    for (const bad of [
      { persons: 0 },
      { persons: 2.5 },
      { days: 8 },
      { days: 0 },
      { meals: [] },
      { meals: ["lunch", "lunch"] },
      { meals: ["breakfast"] },
      { sessions: [{ id: "A", dayOffset: 0 }] },
      { sessions: [{ id: "A", dayOffset: 0 }, { id: "A", dayOffset: 4 }] },
      { sessions: [{ id: "A", dayOffset: 0 }, { id: "B", dayOffset: 7 }] },
      { shoppingDayOffset: -1 },
      { maxHeat: 4 },
      { activeMinutesPerSession: 0 },
      { equipment: ["laser"] },
      { maxProteinFamilies: 0 }
    ]) {
      assert.isTrue(Result.isFailure(decodeHousehold(bad)), JSON.stringify(bad))
    }
  })

  it("gives the day of a session", () => {
    assert.strictEqual(sessionDay(DEFAULT_HOUSEHOLD, "A"), 0)
    assert.strictEqual(sessionDay(DEFAULT_HOUSEHOLD, "B"), 4)
  })
})

describe("WeekPlan", () => {
  const plan = {
    weekStart: "2026-10-17",
    cooking: [{ session: "A", recipeId: 1, scale: 1.5 }],
    meals: [{ day: 0, meal: "lunch", recipeIds: [1] }],
    notes: null
  }
  const decode = (input: unknown) => Schema.decodeUnknownResult(WeekPlan)(input, PLAN_DECODE_OPTIONS)

  it("decodes a plan, and a missing notes key is null", () => {
    assert.isTrue(Result.isSuccess(decode(plan)))
    const { notes: _, ...withoutNotes } = plan
    assert.strictEqual(Result.getOrThrow(decode(withoutNotes)).notes, null)
    assert.strictEqual(Result.getOrThrow(decode({ ...plan, notes: "Лёгкая неделя" })).notes, "Лёгкая неделя")
  })

  it("accepts the scales of the spec only", () => {
    assert.deepStrictEqual(PLAN_SCALES, [0.5, 1, 1.5, 2, 2.5, 3])
    for (const scale of PLAN_SCALES) {
      assert.isTrue(Result.isSuccess(decode({ ...plan, cooking: [{ session: "A", recipeId: 1, scale }] })), String(scale))
    }
    for (const scale of [0, 0.25, 1.25, 3.5, 4, -1]) {
      assert.isTrue(Result.isFailure(decode({ ...plan, cooking: [{ session: "A", recipeId: 1, scale }] })), String(scale))
    }
  })

  it("accepts the days 0 to 6, the meals lunch and dinner, and the sessions A and B", () => {
    assert.isTrue(Result.isFailure(decode({ ...plan, meals: [{ day: 7, meal: "lunch", recipeIds: [1] }] })))
    assert.isTrue(Result.isFailure(decode({ ...plan, meals: [{ day: -1, meal: "lunch", recipeIds: [1] }] })))
    assert.isTrue(Result.isFailure(decode({ ...plan, meals: [{ day: 1, meal: "supper", recipeIds: [1] }] })))
    assert.isTrue(Result.isFailure(decode({ ...plan, cooking: [{ session: "C", recipeId: 1, scale: 1 }] })))
  })

  it("accepts 1 to 3 different dishes in a slot", () => {
    const slot = (recipeIds: ReadonlyArray<number>) => ({ ...plan, meals: [{ day: 0, meal: "lunch", recipeIds }] })
    assert.isTrue(Result.isSuccess(decode(slot([1, 2, 3]))))
    assert.isTrue(Result.isFailure(decode(slot([]))))
    assert.isTrue(Result.isFailure(decode(slot([1, 2, 3, 4]))))
    assert.isTrue(Result.isFailure(decode(slot([1, 1]))))
    assert.isTrue(Result.isFailure(decode(slot([0]))))
    assert.isTrue(Result.isFailure(decode(slot([1.5]))))
  })

  it("cooks a recipe once: 1 cooking entry for each recipe ID", () => {
    const twice = { ...plan, cooking: [{ session: "A", recipeId: 1, scale: 1 }, { session: "B", recipeId: 1, scale: 2 }] }
    const result = decode(twice)
    assert.isTrue(Result.isFailure(result))
    assert.include(Result.isFailure(result) ? result.failure.message : "", "cooked once per week")
  })

  it("has each slot once", () => {
    const twice = { ...plan, meals: [{ day: 0, meal: "lunch", recipeIds: [1] }, { day: 0, meal: "lunch", recipeIds: [2] }] }
    assert.isTrue(Result.isFailure(decode(twice)))
    const different = { ...plan, meals: [{ day: 0, meal: "lunch", recipeIds: [1] }, { day: 0, meal: "dinner", recipeIds: [2] }] }
    assert.isTrue(Result.isSuccess(decode(different)))
  })

  it("needs a date that exists", () => {
    for (const weekStart of ["2026-02-30", "2026-13-01", "17.10.2026", "", "2026-10-17T00:00:00Z"]) {
      assert.isTrue(Result.isFailure(decode({ ...plan, weekStart })), weekStart)
    }
    assert.isTrue(Result.isSuccess(decode({ ...plan, weekStart: "2028-02-29" })))
  })

  it("reports all the problems of the shape in one pass", () => {
    const result = decode({
      weekStart: "2026-02-30",
      cooking: [{ session: "Z", recipeId: 1, scale: 7 }],
      meals: [{ day: 9, meal: "lunch", recipeIds: [] }]
    })
    assert.isTrue(Result.isFailure(result))
    const message = Result.isFailure(result) ? result.failure.message : ""
    for (const field of ["weekStart", "session", "scale", "day", "recipeIds"]) {
      assert.include(message, field)
    }
  })
})

describe("loadHousehold and loadAliases", () => {
  it.live("use the defaults and an empty map if the files are missing", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        assert.deepStrictEqual(yield* loadHousehold(`${root}/config`), DEFAULT_HOUSEHOLD)
        const aliases = yield* loadAliases(`${root}/config`)
        assert.strictEqual(aliases.size, 0)
      })
    ))

  it.live("read the files of the config directory", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, {
          "config/household.json": '{"persons": 2, "recentWeeks": 6}',
          "config/item-aliases.json": '{"Репчатый лук": "лук репчатый"}'
        })
        const household = yield* loadHousehold(`${root}/config`)
        assert.strictEqual(household.persons, 2)
        assert.strictEqual(household.recentWeeks, 6)
        assert.strictEqual(household.maxHeat, 2)
        const aliases = yield* loadAliases(`${root}/config`)
        assert.strictEqual(normaliseItem("репчатый лук", aliases), "лук репчатый")
      })
    ))

  it.live("fail with ConfigError that names the file, for invalid content", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, {
          "config/household.json": '{"persons": 0}',
          "config/item-aliases.json": '{"a": 1}'
        })
        const household = yield* Effect.flip(loadHousehold(`${root}/config`))
        assert.instanceOf(household, ConfigError)
        assert.include(household.message, "household.json")
        const aliases = yield* Effect.flip(loadAliases(`${root}/config`))
        assert.instanceOf(aliases, ConfigError)
        assert.include(aliases.path, "item-aliases.json")
      })
    ))

  it.live("fail for a key that the household does not know, and for text that is not JSON", () =>
    withTempDir((root) =>
      Effect.gen(function*() {
        yield* writeFiles(root, { "config/household.json": '{"persns": 3}', "config/item-aliases.json": "{" })
        assert.include((yield* Effect.flip(loadHousehold(`${root}/config`))).message, "persns")
        assert.instanceOf(yield* Effect.flip(loadAliases(`${root}/config`)), ConfigError)
      })
    ))

  it("the committed config/item-aliases.json is clean and has no chains", () => {
    const text = readFileSync(new URL("../config/item-aliases.json", import.meta.url), "utf8")
    const record = Schema.decodeUnknownSync(AliasesJson)(text)
    const entries = Object.entries(record)
    assert.isAbove(entries.length, 0)
    for (const [variant, canonical] of entries) {
      assert.strictEqual(cleanItemName(variant), variant, `variant "${variant}" is not clean`)
      assert.strictEqual(cleanItemName(canonical), canonical, `canonical "${canonical}" is not clean`)
      assert.notStrictEqual(variant, canonical)
      assert.isFalse(canonical in record, `"${variant}" → "${canonical}" is a chain`)
    }
  })
})
