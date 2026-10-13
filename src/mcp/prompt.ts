import { Result, Schema } from "effect"
import { isCalendarDate } from "../domain/calendar.ts"
import { ProteinFamily } from "../domain/enriched-recipe.ts"
import { IsoDate } from "../domain/recipe.ts"
import type { IsoDate as IsoDateType } from "../domain/recipe.ts"

export const PLAN_WEEK_PROMPT = "plan_week"

export const PLAN_WEEK_DESCRIPTION =
  "Plan one week of lunches and dinners (the method: choose one protein family, cook in two sessions, check with evaluate_plan, save)."

/** The arguments of the prompt. MCP sends every prompt argument as a string. */
export const PlanWeekArguments = Schema.Struct({
  weekStart: IsoDate.pipe(
    Schema.check(Schema.makeFilter<string>((text) => isCalendarDate(text) || "Expected a day that exists in the calendar"))
  ),
  proteinFamily: Schema.optionalKey(ProteinFamily)
})
export type PlanWeekArguments = typeof PlanWeekArguments.Type

export const PLAN_WEEK_ARGUMENTS = [
  { name: "weekStart", description: "Day 0 of the week, the shopping day and the day of session A, as YYYY-MM-DD.", required: true },
  {
    name: "proteinFamily",
    description: `Optional. The protein family to use this week: ${ProteinFamily.literals.join(", ")}.`,
    required: false
  }
] as const

/** Decode the arguments of the prompt. The failure is a Russian text. */
export const decodePlanWeekArguments = (raw: unknown): Result.Result<PlanWeekArguments, string> =>
  Schema.decodeUnknownResult(PlanWeekArguments)(raw ?? {}, { errors: "all" }).pipe(
    Result.mapError((error) => `Неверные аргументы промпта ${PLAN_WEEK_PROMPT}.\n${error.message}`)
  )

/**
 * The text of the prompt `plan_week` (handoff T4.5): the method for the model.
 * The instructions are in English. The answer to the user is in Russian.
 */
export const planWeekPrompt = (weekStart: IsoDateType, proteinFamily: string | undefined): string =>
  [
    `Plan the menu for the week that starts on ${weekStart} (day 0). Use only the tools of this server.`,
    "The household eats 3 persons x 2 meals (lunch, dinner) x 7 days. The household cooks in 2 sessions: A covers days 0 to 3, B covers days 4 to 6.",
    "",
    "Method:",
    "1. Call `household` and `plan_history` (the default is the last 4 plans). Read the limits and the dishes of the last weeks.",
    proteinFamily === undefined
      ? "2. Choose 1 protein family for the week (2 at most). Prefer a family that the last plans used little."
      : `2. Use the protein family \`${proteinFamily}\` (add 1 more family only if you must; 2 families at most).`,
    "3. For each session, call `search_recipes` and choose 2 or 3 dishes. Use filters: `proteinFamilies`, `maxHeat`, `requiresOnly`, `maxActiveMinutes`, `excludeIds` (the dishes of the last plans). Sort by `fewest_items` when you need fewer products.",
    "4. Check these facts in the search rows: `fridgeDays` (the dish must stay fresh until the last day it is eaten), `freezable`, `reheats`, `servings` (portions made must cover the portions eaten), `mealFit` (a `needs_side` dish needs a side dish in the same slot).",
    "5. Build the WeekPlan: `weekStart`, `cooking` (session, recipeId, scale), `meals` (day, meal, recipeIds for all 14 slots). Each dish is cooked once. Each dish is eaten on at most 3 days.",
    "6. Call `evaluate_plan`. Fix every error and change the plan until `ok` is true. Read the warnings and remove them when you can.",
    "7. Lower `buyItemCount`: replace dishes with dishes that share products with the other dishes of the week. Call `evaluate_plan` after each change.",
    "8. Call `shopping_list`, then call `save_plan`.",
    "",
    "Rules:",
    "- Do not change the numbers of the evaluation. The code counts, you choose.",
    "- Tools return titles, links and facts. Do not write recipe intros or steps. Do not copy recipe texts.",
    "",
    "Final answer to the user, in Russian:",
    "- The table of days x meals. Each dish is a link `[title](url)`.",
    "- The schedule of the 2 cooking sessions (dishes, scale, active minutes).",
    "- The value of `buyItemCount`, the protein families and the remaining warnings.",
    "- The shopping list (from `shopping_list`, `markdown`).",
    "- The paths of the saved files."
  ].join("\n")
