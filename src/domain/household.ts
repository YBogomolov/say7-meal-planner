import { Effect, Schema } from "effect"
import { Equipment } from "./enriched-recipe.ts"

/** The cooking sessions of the week (spec H2): A at the weekend, B midweek. */
export const SESSION_IDS = ["A", "B"] as const
export const SessionId = Schema.Literals(SESSION_IDS)
export type SessionId = typeof SessionId.Type

/** The meals of a day (spec H1). Breakfast is out of scope. */
export const MealName = Schema.Literals(["lunch", "dinner"])
export type MealName = typeof MealName.Type

/** A day of the plan week: 0 is the first day (`weekStart`), 6 the last. */
export const DayIndex = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 6 })))

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NaturalInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const PositiveNumber = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeNumber = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/** A cooking session and its day, counted from the first day of the plan week. */
export const HouseholdSession = Schema.Struct({
  id: SessionId,
  dayOffset: DayIndex
})
export type HouseholdSession = typeof HouseholdSession.Type

const hasEachSessionOnce = Schema.makeFilter<ReadonlyArray<HouseholdSession>>((sessions) =>
  (sessions.length === SESSION_IDS.length &&
    SESSION_IDS.every((id) => sessions.filter((session) => session.id === id).length === 1)) ||
  `Expected the sessions ${SESSION_IDS.join(" and ")}, each once`
)

/** Heat levels of the enrichment: 0 none, 1 mild, 2 noticeable, 3 hot. */
const HeatLevel = Schema.Literals([0, 1, 2, 3])

const DEFAULT_MEALS: ReadonlyArray<MealName> = ["lunch", "dinner"]
const DEFAULT_SESSIONS: ReadonlyArray<HouseholdSession> = [{ id: "A", dayOffset: 0 }, { id: "B", dayOffset: 4 }]
const DEFAULT_EQUIPMENT: ReadonlyArray<Equipment> = [
  "hob",
  "oven",
  "microwave",
  "air_fryer",
  "food_processor",
  "blender",
  "immersion_blender",
  "mixer"
]

/**
 * `config/household.json` (spec P4.1). Every key is optional in the file, and a missing key has the default of the spec.
 * A key that the schema does not know is an error when the file is decoded (see `DECODE_OPTIONS`), so a typo does not pass.
 *
 * Day 0 is the first day of the plan week: the shopping day and the day of session A.
 */
export const Household = Schema.Struct({
  /** H1 */
  persons: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  /** H1. At most 7: a `WeekPlan` has the days 0 to 6. */
  days: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 7 })),
    Schema.withDecodingDefaultKey(Effect.succeed(7))
  ),
  /** H1 */
  meals: Schema.Array(MealName).pipe(
    Schema.check(Schema.isNonEmpty(), Schema.isUnique()),
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_MEALS))
  ),
  /** H2. Session A on day 0 (weekend), session B on day 4 (midweek). */
  sessions: Schema.Array(HouseholdSession).pipe(
    Schema.check(hasEachSessionOnce),
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_SESSIONS))
  ),
  /** H3 */
  shoppingDayOffset: DayIndex.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  /** H4 */
  maxDaysPerDish: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  /** H5. Heat above this level is an error. The same level is a warning. */
  maxHeat: HeatLevel.pipe(Schema.withDecodingDefaultKey(Effect.succeed(2))),
  /** H6. More active minutes in a session is a warning. */
  activeMinutesPerSession: PositiveNumber.pipe(Schema.withDecodingDefaultKey(Effect.succeed(150))),
  /** H6. A longer wait is an error. Any wait is a warning. */
  longWaitHoursMax: NonNegativeNumber.pipe(Schema.withDecodingDefaultKey(Effect.succeed(12))),
  /** H7. Equipment outside this list is an error. */
  equipment: Schema.Array(Equipment).pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_EQUIPMENT))),
  /** H8. Days that cooked food stays in the fridge, at most. */
  fridgeDaysCap: NaturalInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
  /** H8. Days that raw poultry and raw meat stay in the fridge. A later session needs the freezer. */
  rawProteinFridgeDays: NaturalInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(2))),
  /** H9. More families are an error. Two or more families are a warning. */
  maxProteinFamilies: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(2))),
  /** A recipe from a plan of these last weeks is a warning. */
  recentWeeks: NaturalInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4)))
})
export type Household = typeof Household.Type

/** Decoding options for `config/household.json`: an unknown key is an error. */
export const DECODE_OPTIONS = { onExcessProperty: "error" } as const

/** JSON text codec for `config/household.json`. */
export const HouseholdJson = Schema.fromJsonString(Household, { space: 2 })

/** The defaults of the spec: what an empty file `{}` decodes to. */
export const DEFAULT_HOUSEHOLD: Household = Schema.decodeUnknownSync(Household)({})

/** The day of a session, counted from the first day of the plan week. */
export const sessionDay = (household: Household, session: SessionId): number =>
  household.sessions.find((candidate) => candidate.id === session)?.dayOffset ?? 0
