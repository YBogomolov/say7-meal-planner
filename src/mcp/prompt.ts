import { Result, Schema } from "effect"
import { isCalendarDate } from "../domain/calendar.ts"
import { ProteinFamily } from "../domain/enriched-recipe.ts"
import { IsoDate } from "../domain/recipe.ts"
import type { IsoDate as IsoDateType } from "../domain/recipe.ts"

export const PLAN_WEEK_PROMPT = "plan_week"

export const PLAN_WEEK_DESCRIPTION =
  "Plan one week of breakfasts, lunches and dinners (the method: choose one protein family, cook in two sessions, add fresh dishes and simple breakfasts for breakfast, check with evaluate_plan, save)."

/** The arguments of the prompt. MCP sends every prompt argument as a string. */
export const PlanWeekArguments = Schema.Struct({
  weekStart: IsoDate.pipe(
    Schema.check(
      Schema.makeFilter<string>((text) => isCalendarDate(text) || "Expected a day that exists in the calendar")
    )
  ),
  proteinFamily: Schema.optionalKey(ProteinFamily),
})
export type PlanWeekArguments = typeof PlanWeekArguments.Type

export const PLAN_WEEK_ARGUMENTS = [
  {
    name: "weekStart",
    description: "Day 0 of the week, the shopping day and the day of session A, as YYYY-MM-DD.",
    required: true,
  },
  {
    name: "proteinFamily",
    description: `Optional. The protein family to use this week: ${ProteinFamily.literals.join(", ")}.`,
    required: false,
  },
] as const

/** Decode the arguments of the prompt. The failure is a Russian text. */
export const decodePlanWeekArguments = (raw: unknown): Result.Result<PlanWeekArguments, string> =>
  Schema.decodeUnknownResult(PlanWeekArguments)(raw ?? {}, {
    errors: "all",
  }).pipe(Result.mapError((error) => `Неверные аргументы промпта ${PLAN_WEEK_PROMPT}.\n${error.message}`))

/**
 * The text of the prompt `plan_week` (handoff T4.5): the method for the model.
 * The instructions are in English. The answer to the user is in Russian.
 */
export const planWeekPrompt = (weekStart: IsoDateType, proteinFamily: string | undefined): string =>
  [
    `Plan the menu for the week that starts on ${weekStart} (day 0). Use only the tools of this server.`,
    "The household eats lunch and dinner with 3 persons, and breakfast with 2 persons (`mealPersons`; the third person has her own simple breakfast and the plan does not count her). 7 days x 3 meals = 21 slots. The household cooks in 2 sessions: A covers days 0 to 3, B covers days 4 to 6.",
    "",
    "Method:",
    "1. Call `household` and `plan_history` (the default is the last 4 plans). Read the limits and the dishes of the last weeks.",
    proteinFamily === undefined
      ? "2. Choose 1 protein family for the week (2 at most). Prefer a family that the last plans used little."
      : `2. Use the protein family \`${proteinFamily}\` (add 1 more family only if you must; 2 families at most).`,
    "3. For each session, call `search_recipes` and choose 2 or 3 dishes. Use filters: `proteinFamilies`, `maxHeat`, `requiresOnly`, `maxActiveMinutes`, `excludeIds` (the dishes of the last plans). Sort by `fewest_items` when you need fewer products.",
    "4. Check these facts in the search rows: `fridgeDays` (the dish must stay fresh until the last day it is eaten), `freezable`, `reheats`, `servings` (portions made must cover the portions eaten), `mealFit` (a `needs_side` dish needs a side dish in the same slot).",
    "5. Build the WeekPlan: `weekStart`, `cooking` (session, recipeId, scale), `meals` (day, meal, recipeIds and simpleIds for all 21 slots: breakfast, lunch, dinner). Each dish is cooked once. Each dish is eaten on at most 3 days.",
    "6. Breakfast (a slot with `meal: breakfast`, 2 persons) has 3 kinds of dish. Use the kind that fits the day:",
    "   - A simple breakfast: call `simple_breakfasts`, put its `id` in `simpleIds` of the slot. It has no cooking entry and no recipe. A slot can have `recipeIds` and `simpleIds` together, and at least one of the two. Simple breakfasts are only for breakfast slots (else the error `simple_not_breakfast`). An unknown ID is the error `unknown_simple`.",
    '   - A fresh dish: a cooking entry with `session: "fresh"`. The household cooks it in the morning of each day that it is eaten, so `scale` is for one cooking day and the shopping list multiplies the quantities by the number of days. Choose a quick dish: the active time of the fresh dishes of one day must stay within `freshMinutesMax` (the warning `fresh_time`). Fresh dishes are only for breakfast slots (else the error `fresh_not_breakfast`). Fresh dishes have no freshness limit and no share of the session minutes.',
    "   - A dish of a session (leftovers) can also stand in a breakfast slot, with the usual rules of the fridge.",
    '   To find breakfast recipes, call `search_recipes` with `forMeal: "breakfast"` (pancakes, egg dishes, sandwiches, casseroles, cottage cheese bakes). A recipe with `mealFit: not_a_meal` is valid only in a breakfast slot (the error `breakfast_only_recipe`). Breakfast slots are not checked by `slot_not_a_meal`.',
    "7. Protein: every slot needs protein per portion of at least `proteinMinGrams` from `household` (breakfast 15 g, lunch 20 g, dinner 20 g). `evaluate_plan` gives `proteinPerSlot` and the warning `low_protein`. Add a dish or a simple breakfast with more protein when a slot is low.",
    "8. Call `evaluate_plan`. Fix every error and change the plan until `ok` is true. Read the warnings and remove them when you can.",
    "9. Lower `buyItemCount` (it counts the products of the simple breakfasts too): replace dishes with dishes that share products with the other dishes of the week. Call `evaluate_plan` after each change.",
    "10. Call `shopping_list`, then call `save_plan`.",
    "",
    "Rules:",
    "- Do not change the numbers of the evaluation. The code counts, you choose.",
    "- Tools return titles, links and facts. Do not write recipe intros or steps. Do not copy recipe texts.",
    "",
    "Final answer to the user, in Russian:",
    "- The table of days x meals, with the breakfast column first. Each recipe is a link `[title](url)`. A simple breakfast is its title.",
    "- The schedule of the 2 cooking sessions (dishes, scale, active minutes) and the fresh dishes of the mornings.",
    "- The value of `buyItemCount`, the protein families and the remaining warnings.",
    "- The shopping list (from `shopping_list`, `markdown`).",
    "- The paths of the saved files.",
  ].join("\n")
