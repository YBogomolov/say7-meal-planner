import { Schema } from "effect"
import { ProteinFamily } from "./enriched-recipe.ts"
import { DayIndex, SessionId } from "./household.ts"
import { RecipeId } from "./recipe.ts"
import { PlanScale } from "./week-plan.ts"

/** The codes of the rules of spec P4.4 and P4.8. The codes are stable: the callers match on them. */
export const ISSUE_CODES = [
  "unknown_recipe",
  "not_cooked",
  "cooked_not_eaten",
  "slot_missing",
  "slot_not_a_meal",
  "eaten_before_cooked",
  "portions_short",
  "portions_tight",
  "portions_left",
  "too_many_days",
  "same_day_twice",
  "not_fresh",
  "heat",
  "equipment",
  "active_time",
  "long_wait",
  "protein_families",
  "recent_repeat",
  "dish_type_excluded",
  "side_repeated",
  "heavy_dinner",
  "item_limit"
] as const
export const IssueCode = Schema.Literals(ISSUE_CODES)
export type IssueCode = typeof IssueCode.Type

/** One problem of a plan. `message` is Russian text for the user. `days` counts from day 0 of the plan week. */
export const PlanIssue = Schema.Struct({
  code: IssueCode,
  message: Schema.String,
  recipeIds: Schema.Array(RecipeId),
  days: Schema.Array(DayIndex)
})
export type PlanIssue = typeof PlanIssue.Type

const PortionRange = Schema.Struct({ min: Schema.Finite, max: Schema.Finite })

/** The portions of one cooked dish. `left` is negative if the dish is short. */
export const DishPortions = Schema.Struct({
  recipeId: RecipeId,
  scale: PlanScale,
  /** `servings.min × scale` and `servings.max × scale`. */
  made: PortionRange,
  /** `persons × number of slots with the dish`. */
  eaten: Schema.Natural,
  /** `made − eaten`. */
  left: PortionRange
})
export type DishPortions = typeof DishPortions.Type

export const SessionMinutes = Schema.Struct({
  session: SessionId,
  /** The sum of `activeMinutes × scale factor` of the dishes of the session. */
  minutes: Schema.Finite
})
export type SessionMinutes = typeof SessionMinutes.Type

/** Spec P4.4, "Metrics". The dishes that are not in the catalogue do not count. */
export const PlanMetrics = Schema.Struct({
  /** Distinct normalised items that are not pantry and not optional: the main objective of the plan. */
  buyItemCount: Schema.Natural,
  /** Distinct normalised pantry items. */
  pantryItemCount: Schema.Natural,
  /** Distinct protein families of all cooked dishes. */
  proteinFamilies: Schema.Array(ProteinFamily),
  /** Number of cooked dishes. */
  dishCount: Schema.Natural,
  portions: Schema.Array(DishPortions),
  activeMinutes: Schema.Array(SessionMinutes),
  /** Number of slots of `days × meals` that have at least 1 dish. */
  slotsCovered: Schema.Natural,
  /** Number of slots of `days × meals`. */
  slotsRequired: Schema.Natural
})
export type PlanMetrics = typeof PlanMetrics.Type

/** The result of `evaluatePlan` (spec P4.4). `ok` is true if there are no errors. Warnings do not change `ok`. */
export const PlanEvaluation = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(PlanIssue),
  warnings: Schema.Array(PlanIssue),
  metrics: PlanMetrics
})
export type PlanEvaluation = typeof PlanEvaluation.Type
