import { Effect, Schema } from "effect"
import { isCalendarDate } from "./calendar.ts"
import { DayIndex, MealName, SessionId } from "./household.ts"
import { IsoDate, RecipeId } from "./recipe.ts"

/** The factors by which a cooking session multiplies a recipe (spec P4.3). */
export const PLAN_SCALES = [0.5, 1, 1.5, 2, 2.5, 3] as const
export const PlanScale = Schema.Literals(PLAN_SCALES)
export type PlanScale = typeof PlanScale.Type

/** A plan day is a real date: `2026-02-30` has the right form but no such day exists. */
const CalendarDate = IsoDate.pipe(
  Schema.check(Schema.makeFilter<string>((text) => isCalendarDate(text) || "Expected a day that exists in the calendar"))
)

/** One dish that a session cooks, and the factor for its quantities. */
export const CookingEntry = Schema.Struct({
  session: SessionId,
  recipeId: RecipeId,
  scale: PlanScale
})
export type CookingEntry = typeof CookingEntry.Type

/** The dishes of one slot (a meal of a day). A slot has 1 to 3 dishes, for example a main dish and a side. */
export const MealEntry = Schema.Struct({
  day: DayIndex,
  meal: MealName,
  recipeIds: Schema.Array(RecipeId).pipe(Schema.check(Schema.isBetweenLength(1, 3), Schema.isUnique()))
})
export type MealEntry = typeof MealEntry.Type

const hasUniqueCooking = Schema.makeFilter<ReadonlyArray<CookingEntry>>((entries) =>
  new Set(entries.map((entry) => entry.recipeId)).size === entries.length ||
  "A recipe is cooked once per week: expected 1 cooking entry for each recipe ID"
)

const hasUniqueSlots = Schema.makeFilter<ReadonlyArray<MealEntry>>((entries) =>
  new Set(entries.map((entry) => `${entry.day}/${entry.meal}`)).size === entries.length ||
  "Expected each slot (day and meal) once"
)

/**
 * The plan of one week (spec P4.3).
 *
 * The decoder checks the shape: the scales, the days 0 to 6, 1 to 3 different dishes in a slot,
 * 1 cooking entry for each recipe, each slot once, and a real calendar date.
 * The rules of the household (for example "a dish in `meals` must be in `cooking`") are in `evaluatePlan`.
 * A missing `notes` key is `null`.
 */
export const WeekPlan = Schema.Struct({
  /** Day 0 of the week: the first day. */
  weekStart: CalendarDate,
  cooking: Schema.Array(CookingEntry).pipe(Schema.check(hasUniqueCooking)),
  meals: Schema.Array(MealEntry).pipe(Schema.check(hasUniqueSlots)),
  notes: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))
})
export type WeekPlan = typeof WeekPlan.Type

/** Decoding options for a plan from a user or a model: report every problem of the shape in one pass. */
export const PLAN_DECODE_OPTIONS = { errors: "all" } as const

/** JSON text codec for `data/plans/<weekStart>.json`. */
export const WeekPlanJson = Schema.fromJsonString(WeekPlan, { space: 2 })
