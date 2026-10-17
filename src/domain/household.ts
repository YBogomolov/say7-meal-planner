import { Effect, Schema } from "effect"
import { DishType, Equipment, IngredientCategory } from "./enriched-recipe.ts"
import { RecipeId } from "./recipe.ts"

/** The cooking sessions of the week (spec H2): A at the weekend, B midweek. */
export const SESSION_IDS = ["A", "B"] as const
export const SessionId = Schema.Literals(SESSION_IDS)
export type SessionId = typeof SessionId.Type

/** The meals of a day (spec H1 and P7.2), in the order of the day. */
export const MEAL_NAMES = ["breakfast", "lunch", "dinner"] as const
export const MealName = Schema.Literals(MEAL_NAMES)
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
  dayOffset: DayIndex,
})
export type HouseholdSession = typeof HouseholdSession.Type

const hasEachSessionOnce = Schema.makeFilter<ReadonlyArray<HouseholdSession>>(
  (sessions) =>
    (sessions.length === SESSION_IDS.length &&
      SESSION_IDS.every((id) => sessions.filter((session) => session.id === id).length === 1)) ||
    `Expected the sessions ${SESSION_IDS.join(" and ")}, each once`
)

/** Heat levels of the enrichment: 0 none, 1 mild, 2 noticeable, 3 hot. */
const HeatLevel = Schema.Literals([0, 1, 2, 3])

const DEFAULT_MEALS: ReadonlyArray<MealName> = ["lunch", "dinner"]
const DEFAULT_SESSIONS: ReadonlyArray<HouseholdSession> = [
  { id: "A", dayOffset: 0 },
  { id: "B", dayOffset: 4 },
]
const DEFAULT_EQUIPMENT: ReadonlyArray<Equipment> = [
  "hob",
  "oven",
  "microwave",
  "air_fryer",
  "food_processor",
  "blender",
  "immersion_blender",
  "mixer",
]

const ItemNames = Schema.Array(Schema.NonEmptyString)

/** A limit of the taste rules: at most `maxDishes` cooked dishes of the week have any of `items`. */
export const ItemLimit = Schema.Struct({
  name: Schema.NonEmptyString,
  items: ItemNames,
  maxDishes: NaturalInt,
})
export type ItemLimit = typeof ItemLimit.Type

/**
 * `household.preferences` (spec P4.8). Every key is optional. The item names are cleaned and mapped through
 * the alias map when the rules run, so the file can use any variant of a name.
 */
export const Preferences = Schema.Struct({
  /** Dish types that the household does not eat: a cooked dish of this type is an error. */
  excludedDishTypes: Schema.Array(DishType).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<DishType>>([]))
  ),
  /** The base of a plate: `{ "<group>": item[] }`. */
  sideGroups: Schema.Record(Schema.String, ItemNames).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<Readonly<Record<string, ReadonlyArray<string>>>>({}))
  ),
  /** A buy-ingredient gives its side group only if its grams at scale 1 are at least this value, or unknown. */
  sideMinGrams: NonNegativeNumber.pipe(Schema.withDecodingDefaultKey(Effect.succeed(100))),
  /** Side groups that are too heavy for dinner. */
  dinnerAvoidSideGroups: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /** Items that are too heavy for dinner. */
  dinnerAvoidItems: ItemNames.pipe(Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))),
  itemLimits: Schema.Array(ItemLimit).pipe(Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<ItemLimit>>([]))),
})
export type Preferences = typeof Preferences.Type

/**
 * `household.proteinMinGrams` (spec P7.1): the least protein in grams for the dishes of a slot, for each meal.
 */
export const ProteinMinGrams = Schema.Struct({
  breakfast: NonNegativeNumber.pipe(Schema.withDecodingDefaultKey(Effect.succeed(15))),
  lunch: NonNegativeNumber.pipe(Schema.withDecodingDefaultKey(Effect.succeed(20))),
  dinner: NonNegativeNumber.pipe(Schema.withDecodingDefaultKey(Effect.succeed(20))),
})
export type ProteinMinGrams = typeof ProteinMinGrams.Type

/**
 * `household.mealPersons` (spec P7.2.1): the persons of a meal, if they differ from `persons`.
 * A meal without a key uses `persons`.
 */
export const MealPersons = Schema.Struct({
  breakfast: Schema.optionalKey(PositiveInt),
  lunch: Schema.optionalKey(PositiveInt),
  dinner: Schema.optionalKey(PositiveInt),
})
export type MealPersons = typeof MealPersons.Type

/**
 * One entry of `household.weeklyExtras` (spec P7.3): a product that the household buys every week.
 * The plan does not count it. `amount` and `note` are free text.
 */
export const WeeklyExtra = Schema.Struct({
  item: Schema.NonEmptyString,
  amount: Schema.NonEmptyString,
  category: IngredientCategory,
  note: Schema.NonEmptyString,
})
export type WeeklyExtra = typeof WeeklyExtra.Type

const DEFAULT_PROTEIN_MIN_GRAMS: ProteinMinGrams = Schema.decodeUnknownSync(ProteinMinGrams)({})

const DEFAULT_PREFERENCES: Preferences = Schema.decodeUnknownSync(Preferences)({})

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
  recentWeeks: NaturalInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
  /** P7.1. Rule `low_protein`: the least protein in grams of a slot, for each meal. */
  proteinMinGrams: ProteinMinGrams.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_PROTEIN_MIN_GRAMS))),
  /** P7.2.1. Persons of a meal, for example `{ "breakfast": 2 }`. Another meal uses `persons`. */
  mealPersons: MealPersons.pipe(Schema.withDecodingDefaultKey(Effect.succeed<MealPersons>({}))),
  /** P7.2.2. Rule `fresh_time`: the active minutes of the fresh dishes of one day, at most. */
  freshMinutesMax: PositiveNumber.pipe(Schema.withDecodingDefaultKey(Effect.succeed(20))),
  /** P7.2.4. Recipes that are breakfast candidates, in addition to the categories of the spec. */
  breakfastExtraIds: Schema.Array(RecipeId).pipe(
    Schema.check(Schema.isUnique()),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<RecipeId>>([]))
  ),
  /** P7.4. Recipes that are valid in dinner slots even if `mealFit` is `not_a_meal`. They are in the scope of the enrichment and are breakfast candidates. */
  lightDinnerIds: Schema.Array(RecipeId).pipe(
    Schema.check(Schema.isUnique()),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<RecipeId>>([]))
  ),
  /** P7.3. Products that the shopping list shows every week, outside the departments. */
  weeklyExtras: Schema.Array(WeeklyExtra).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<WeeklyExtra>>([]))
  ),
  /** P4.8. Taste rules. Without the key, all lists are empty and the rules find nothing. */
  preferences: Preferences.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_PREFERENCES))),
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

/** The persons that eat a meal (spec P7.2.1): `mealPersons` for the meal, else `persons`. */
export const personsOf = (household: Household, meal: MealName): number =>
  household.mealPersons[meal] ?? household.persons
