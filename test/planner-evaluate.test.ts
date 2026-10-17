import { assert, describe, it } from "@effect/vitest"
import type { Aliases, CatalogueEntry } from "../src/domain/catalogue.ts"
import { DEFAULT_HOUSEHOLD } from "../src/domain/household.ts"
import type { Household, Preferences } from "../src/domain/household.ts"
import { ISSUE_CODES } from "../src/domain/plan-evaluation.ts"
import type { IssueCode, PlanEvaluation, PlanIssue } from "../src/domain/plan-evaluation.ts"
import type { SimpleBreakfast } from "../src/domain/simple-breakfast.ts"
import type { WeekPlan } from "../src/domain/week-plan.ts"
import { evaluatePlan } from "../src/planner/evaluate.ts"
import { makeAliases, NO_ALIASES } from "../src/planner/items.ts"
import { makeProteinTable } from "../src/planner/protein.ts"
import {
  baseCatalogue,
  baseEntries,
  BASE_COOKING,
  BASE_MEALS,
  catalogueOf,
  entryOf,
  ing,
  inGrams,
  PANCAKES,
  planOf,
} from "./support/planner.ts"
import type { DishOptions, EnrichmentChange, PlanSpec } from "./support/planner.ts"

interface Scenario {
  readonly cooking?: PlanSpec["cooking"]
  readonly meals?: PlanSpec["meals"]
  readonly weekStart?: string
  /** Replace the options of dishes of the base week, by ID. */
  readonly dishes?: Readonly<Record<number, DishOptions>>
  /** Dishes in addition to the 7 of the base week. */
  readonly extra?: ReadonlyArray<CatalogueEntry>
  readonly household?: Partial<Household>
  readonly history?: ReadonlyArray<WeekPlan>
  readonly aliases?: Aliases
  /** The protein table `{ "<item>": g per 100 g }`. Without it the table is empty and `low_protein` is off. */
  readonly protein?: Readonly<Record<string, number>>
  /** The simple breakfasts of the catalogue (spec P7.2.3). */
  readonly simple?: ReadonlyArray<SimpleBreakfast>
}

const evaluate = (scenario: Scenario = {}): PlanEvaluation =>
  evaluatePlan(
    planOf({
      weekStart: scenario.weekStart ?? "2026-10-17",
      cooking: scenario.cooking ?? BASE_COOKING,
      meals: scenario.meals ?? BASE_MEALS,
    }),
    catalogueOf(
      [...baseEntries(scenario.dishes, scenario.aliases), ...(scenario.extra ?? [])],
      scenario.aliases,
      makeProteinTable(scenario.protein ?? {}, scenario.aliases ?? NO_ALIASES),
      scenario.simple ?? []
    ),
    { ...DEFAULT_HOUSEHOLD, ...scenario.household },
    scenario.history ?? []
  )

/** The recipe IDs of an issue as plain numbers. */
const idsOf = (issue: PlanIssue): ReadonlyArray<number> => issue.recipeIds.map(Number)

const codes = (issues: ReadonlyArray<PlanIssue>): ReadonlyArray<IssueCode> => issues.map((issue) => issue.code)

const issueOf = (issues: ReadonlyArray<PlanIssue>, code: IssueCode): PlanIssue => {
  const found = issues.find((issue) => issue.code === code)
  return found === undefined ? assert.fail(`no issue ${code}; got ${codes(issues).join(", ")}`) : found
}

type Slots = PlanSpec["meals"]

/** The base week with some slots replaced. */
const withMeals = (...changes: Slots): Slots =>
  BASE_MEALS.map((slot) => changes.find((change) => change.day === slot.day && change.meal === slot.meal) ?? slot)

/** The base week with one meal slot replaced. */
const withMeal = (day: number, meal: "lunch" | "dinner", recipeIds: ReadonlyArray<number>): Slots =>
  withMeals({ day, meal, recipeIds })

const scaled = (recipeId: number, scale: 0.5 | 1 | 1.5 | 2 | 2.5 | 3): PlanSpec["cooking"] =>
  BASE_COOKING.map((entry) => (entry.recipeId === recipeId ? { ...entry, scale } : entry))

const servings = (min: number, max: number): EnrichmentChange => ({
  servings: { min, max, source: "page" },
})

/** A household with some taste preferences (spec P4.8). */
const prefs = (preferences: Partial<Preferences>): Partial<Household> => ({
  preferences: { ...DEFAULT_HOUSEHOLD.preferences, ...preferences },
})

const GARNISH = (n: number, overrides: EnrichmentChange = {}) =>
  entryOf(n, {
    title: `Гарнир Индия ${n}`,
    enrichment: {
      dishType: "side",
      mealFit: "side_only",
      servings: { min: 6, max: 8, source: "page" },
      ...overrides,
    },
    ingredients: [inGrams("рис", 100, { category: "grain" })],
  })

/** A fresh breakfast dish: quick, 2 to 4 portions (spec P7.2.2). */
const FRESH = (n: number, overrides: EnrichmentChange = {}) =>
  entryOf(n, {
    title: `Завтрак Квебек ${n}`,
    enrichment: {
      mealFit: "full_meal",
      servings: { min: 2, max: 4, source: "page" },
      activeMinutes: 10,
      fridgeDays: 1,
      ...overrides,
    },
    ingredients: [inGrams("творог", 300, { category: "dairy" }), inGrams("яйца", 110, { category: "eggs" })],
  })

/** A sweet bake that is no meal, but a breakfast candidate (category 50). */
const BREAKFAST_ONLY = (n: number) =>
  entryOf(n, {
    title: `Сырники Рим ${n}`,
    categories: [PANCAKES],
    enrichment: {
      mealFit: "not_a_meal",
      servings: { min: 2, max: 4, source: "page" },
      activeMinutes: 10,
    },
    ingredients: [inGrams("творог", 300, { category: "dairy" })],
  })

const YOGURT: SimpleBreakfast = {
  id: "yogurt",
  title: "Йогурт с бананом",
  items: [
    { item: "греческий йогурт", grams: 200, category: "dairy", pantry: false },
    { item: "мед", grams: 15, category: "sweet", pantry: true },
  ],
}

describe("evaluatePlan: the base week", () => {
  const evaluation = evaluate()

  it("has no error and no warning", () => {
    assert.deepStrictEqual(codes(evaluation.errors), [])
    assert.deepStrictEqual(codes(evaluation.warnings), [])
    assert.isTrue(evaluation.ok)
  })

  it("has the metrics of spec P4.4", () => {
    const { metrics } = evaluation
    assert.strictEqual(metrics.buyItemCount, 14)
    assert.strictEqual(metrics.pantryItemCount, 4)
    assert.deepStrictEqual(metrics.proteinFamilies, ["chicken"])
    assert.strictEqual(metrics.dishCount, 7)
    assert.strictEqual(metrics.slotsCovered, 14)
    assert.strictEqual(metrics.slotsRequired, 14)
    assert.deepStrictEqual(metrics.activeMinutes, [
      { session: "A", minutes: 80 },
      { session: "B", minutes: 60 },
    ])
    assert.deepStrictEqual(metrics.portions[0], {
      recipeId: 1,
      scale: 1,
      made: { min: 6, max: 8 },
      eaten: 6,
      left: { min: 0, max: 2 },
    })
    assert.strictEqual(metrics.portions.length, 7)
  })

  it("counts the buy items by the normalised name: optional and pantry items do not count", () => {
    // "укроп" is optional in dish 7 but a buy item in dish 4: it counts once. "ванилин" and "сыр" are optional only.
    assert.strictEqual(evaluation.metrics.buyItemCount, 14)
  })
})

describe("evaluatePlan: unknown_recipe (E)", () => {
  it("fires for a recipe that the catalogue does not have, and the other rules still run", () => {
    const evaluation = evaluate({
      cooking: [...BASE_COOKING, { session: "A", recipeId: 99 }],
      meals: withMeal(0, "dinner", [2, 99]),
    })
    const issue = issueOf(evaluation.errors, "unknown_recipe")
    assert.deepStrictEqual(idsOf(issue), [99])
    assert.deepStrictEqual(issue.days, [0])
    assert.isFalse(evaluation.ok)
    assert.notInclude(codes(evaluation.errors), "not_cooked")
    assert.strictEqual(evaluation.metrics.dishCount, 7)
  })

  it("does not fire when every recipe is in the catalogue", () => {
    assert.notInclude(codes(evaluate().errors), "unknown_recipe")
  })

  it("still reports eaten_before_cooked for the unknown recipe, because that rule needs no catalogue", () => {
    const evaluation = evaluate({
      cooking: [...BASE_COOKING, { session: "B", recipeId: 99 }],
      meals: withMeal(0, "dinner", [2, 99]),
    })
    assert.deepStrictEqual(idsOf(issueOf(evaluation.errors, "eaten_before_cooked")), [99])
  })
})

describe("evaluatePlan: not_cooked (E)", () => {
  it("fires for a dish in meals that no session cooks", () => {
    const evaluation = evaluate({
      cooking: BASE_COOKING.filter((entry) => entry.recipeId !== 4),
    })
    const issue = issueOf(evaluation.errors, "not_cooked")
    assert.deepStrictEqual(idsOf(issue), [4])
    assert.deepStrictEqual(issue.days, [2, 3])
  })

  it("does not fire when every dish of meals is cooked", () => {
    assert.notInclude(codes(evaluate().errors), "not_cooked")
  })
})

describe("evaluatePlan: cooked_not_eaten (W)", () => {
  const extra = [entryOf(8, { title: "Рагу Индия" })]

  it("fires for a cooked dish that is in no meal", () => {
    const evaluation = evaluate({
      cooking: [...BASE_COOKING, { session: "B", recipeId: 8 }],
      extra,
    })
    assert.deepStrictEqual(idsOf(issueOf(evaluation.warnings, "cooked_not_eaten")), [8])
    assert.isTrue(evaluation.ok)
  })

  it("does not fire when every cooked dish is eaten", () => {
    assert.notInclude(codes(evaluate().warnings), "cooked_not_eaten")
  })
})

describe("evaluatePlan: slot_missing (E)", () => {
  it("fires for each slot without a dish, in one pass", () => {
    const meals = BASE_MEALS.filter(
      (slot) => !(slot.day === 3 && slot.meal === "dinner") && !(slot.day === 6 && slot.meal === "lunch")
    )
    const evaluation = evaluate({ meals })
    const missing = evaluation.errors.filter((issue) => issue.code === "slot_missing")
    assert.deepStrictEqual(
      missing.map((issue) => issue.days),
      [[3], [6]]
    )
    assert.include(missing[0]?.message ?? "", "ужин")
    assert.include(missing[1]?.message ?? "", "обед")
    assert.strictEqual(evaluation.metrics.slotsCovered, 12)
  })

  it("does not fire when all 14 slots have a dish", () => {
    assert.notInclude(codes(evaluate().errors), "slot_missing")
  })

  it("follows the household: 5 days need 10 slots", () => {
    const meals = BASE_MEALS.filter((slot) => slot.day < 5)
    assert.notInclude(codes(evaluate({ meals, household: { days: 5 } }).errors), "slot_missing")
    assert.include(codes(evaluate({ meals, household: { days: 6 } }).errors), "slot_missing")
  })
})

describe("evaluatePlan: slot_not_a_meal (E)", () => {
  const needsSide = { 3: { enrichment: { mealFit: "needs_side" as const } } }

  it("fires for a slot with a dish that needs a side and has no side", () => {
    const evaluation = evaluate({ dishes: needsSide })
    const slots = evaluation.errors.filter((issue) => issue.code === "slot_not_a_meal")
    assert.deepStrictEqual(
      slots.map((issue) => issue.days),
      [[2], [3]]
    )
    assert.deepStrictEqual(slots[0]?.recipeIds.map(Number), [3])
  })

  it("fires for a slot with a side_only dish alone", () => {
    const evaluation = evaluate({
      dishes: { 3: { enrichment: { mealFit: "side_only" } } },
    })
    assert.include(codes(evaluation.errors), "slot_not_a_meal")
  })

  it("fires for 2 dishes that both need a side", () => {
    const evaluation = evaluate({
      dishes: needsSide,
      cooking: [...BASE_COOKING, { session: "A", recipeId: 8 }],
      meals: withMeal(2, "lunch", [3, 8]),
      extra: [
        entryOf(8, {
          enrichment: {
            mealFit: "needs_side",
            servings: { min: 6, max: 8, source: "page" },
          },
        }),
      ],
    })
    assert.deepStrictEqual(issueOf(evaluation.errors, "slot_not_a_meal").days, [2])
  })

  it("does not fire for a full_meal dish", () => {
    assert.notInclude(codes(evaluate().errors), "slot_not_a_meal")
  })

  it("does not fire for a needs_side dish together with a side_only dish", () => {
    const evaluation = evaluate({
      dishes: needsSide,
      cooking: [...BASE_COOKING, { session: "A", recipeId: 8 }],
      meals: withMeals({ day: 2, meal: "lunch", recipeIds: [3, 8] }, { day: 3, meal: "lunch", recipeIds: [3, 8] }),
      extra: [GARNISH(8)],
    })
    assert.notInclude(codes(evaluation.errors), "slot_not_a_meal")
  })

  it("does not fire for a needs_side dish together with a dish of type side", () => {
    const evaluation = evaluate({
      dishes: needsSide,
      cooking: [...BASE_COOKING, { session: "A", recipeId: 8 }],
      meals: withMeals({ day: 2, meal: "lunch", recipeIds: [3, 8] }, { day: 3, meal: "lunch", recipeIds: [3, 8] }),
      extra: [GARNISH(8, { mealFit: "full_meal" })],
    })
    assert.notInclude(codes(evaluation.errors), "slot_not_a_meal")
  })

  it("does not judge a slot that has an unknown recipe: unknown_recipe is the error", () => {
    const evaluation = evaluate({
      dishes: needsSide,
      cooking: [...BASE_COOKING, { session: "A", recipeId: 99 }],
      meals: withMeal(2, "lunch", [3, 99]),
    })
    assert.deepStrictEqual(
      evaluation.errors.filter((issue) => issue.code === "slot_not_a_meal").map((issue) => issue.days),
      [[3]]
    )
  })
})

describe("evaluatePlan: eaten_before_cooked (E)", () => {
  it("fires for a dish that is eaten before its session day", () => {
    const cooking = BASE_COOKING.map((entry) => (entry.recipeId === 1 ? { ...entry, session: "B" as const } : entry))
    const issue = issueOf(evaluate({ cooking }).errors, "eaten_before_cooked")
    assert.deepStrictEqual(idsOf(issue), [1])
    assert.deepStrictEqual(issue.days, [0, 1])
  })

  it("does not fire for a dish that is eaten on the day of its session or later", () => {
    // Dish 1 is cooked on day 0 and eaten on day 0: not early.
    assert.notInclude(codes(evaluate().errors), "eaten_before_cooked")
  })

  it("uses the day of the session from the household", () => {
    const early = evaluate({
      household: {
        sessions: [
          { id: "A", dayOffset: 0 },
          { id: "B", dayOffset: 3 },
        ],
      },
    })
    assert.notInclude(codes(early.errors), "eaten_before_cooked")
    const late = evaluate({
      household: {
        sessions: [
          { id: "A", dayOffset: 1 },
          { id: "B", dayOffset: 4 },
        ],
      },
    })
    assert.deepStrictEqual(issueOf(late.errors, "eaten_before_cooked").days, [0])
  })
})

describe("evaluatePlan: portions_short (E)", () => {
  it("fires when the portions eaten are more than servings.max × scale", () => {
    const evaluation = evaluate({ cooking: scaled(1, 0.5) })
    const issue = issueOf(evaluation.errors, "portions_short")
    assert.deepStrictEqual(idsOf(issue), [1])
    assert.include(issue.message, "6 порц.")
    assert.include(issue.message, "не больше 4")
    assert.deepStrictEqual(evaluation.metrics.portions[0]?.left, {
      min: -3,
      max: -2,
    })
  })

  it("counts a portion for each person and each slot with the dish", () => {
    // 4 persons: 2 slots × 4 = 8 portions, and 8 is not more than servings.max.
    assert.notInclude(codes(evaluate({ household: { persons: 4 } }).errors), "portions_short")
    assert.include(codes(evaluate({ household: { persons: 5 } }).errors), "portions_short")
  })

  it("does not fire when the portions eaten are not more than servings.max × scale", () => {
    assert.notInclude(codes(evaluate().errors), "portions_short")
    // Exactly equal to servings.max: 6 eaten, servings.max 6.
    assert.notInclude(codes(evaluate({ dishes: { 1: { enrichment: servings(6, 6) } } }).errors), "portions_short")
  })

  it("counts every slot that has the dish, also a slot with other dishes", () => {
    // Dish 8 is a side dish in 3 slots next to the main dishes: 3 × 3 = 9 portions, more than 8.
    const evaluation = evaluate({
      cooking: [...BASE_COOKING, { session: "A", recipeId: 8 }],
      meals: BASE_MEALS.map((slot) =>
        slot.day <= 2 && slot.meal === "lunch" ? { ...slot, recipeIds: [...slot.recipeIds, 8] } : slot
      ),
      extra: [GARNISH(8)],
    })
    const issue = issueOf(evaluation.errors, "portions_short")
    assert.deepStrictEqual(idsOf(issue), [8])
    assert.deepStrictEqual(issue.days, [0, 1, 2])
  })
})

describe("evaluatePlan: portions_tight (W)", () => {
  it("fires when the portions eaten are more than servings.min × scale, but not more than servings.max × scale", () => {
    const evaluation = evaluate({
      dishes: { 1: { enrichment: servings(4, 8) } },
    })
    assert.deepStrictEqual(idsOf(issueOf(evaluation.warnings, "portions_tight")), [1])
    assert.notInclude(codes(evaluation.errors), "portions_short")
    assert.isTrue(evaluation.ok)
  })

  it("does not fire when the portions eaten equal servings.min × scale", () => {
    assert.notInclude(codes(evaluate().warnings), "portions_tight")
  })

  it("does not repeat a dish that is short: portions_short already says it", () => {
    const evaluation = evaluate({ cooking: scaled(1, 0.5) })
    assert.include(codes(evaluation.errors), "portions_short")
    assert.notInclude(codes(evaluation.warnings), "portions_tight")
  })

  it("uses the scale", () => {
    const evaluation = evaluate({
      cooking: scaled(1, 1.5),
      dishes: { 1: { enrichment: servings(2, 8) } },
    })
    // made.min 3, made.max 12, eaten 6.
    assert.deepStrictEqual(idsOf(issueOf(evaluation.warnings, "portions_tight")), [1])
    const fine = evaluate({
      cooking: scaled(1, 3),
      dishes: { 1: { enrichment: servings(2, 8) } },
    })
    assert.notInclude(codes(fine.warnings), "portions_tight")
  })
})

describe("evaluatePlan: portions_left (W)", () => {
  it("fires when more than persons × 2 portions stay even at servings.min", () => {
    const evaluation = evaluate({ cooking: scaled(1, 2.5) })
    // made 15 to 20, eaten 6: left 9 to 14.
    assert.deepStrictEqual(idsOf(issueOf(evaluation.warnings, "portions_left")), [1])
    assert.isTrue(evaluation.ok)
  })

  it("does not fire for exactly persons × 2 portions left", () => {
    // made.min 12, eaten 6: left 6, and 6 is not more than 6.
    assert.notInclude(codes(evaluate({ cooking: scaled(1, 2) }).warnings), "portions_left")
  })

  it("does not fire when only the upper end of the yield would leave more", () => {
    const evaluation = evaluate({
      dishes: { 1: { enrichment: servings(6, 20) } },
    })
    assert.notInclude(codes(evaluation.warnings), "portions_left")
  })

  it("fires for a dish that is cooked and not eaten, next to cooked_not_eaten", () => {
    const evaluation = evaluate({
      cooking: [...BASE_COOKING, { session: "B", recipeId: 8 }],
      extra: [entryOf(8, { enrichment: servings(8, 8) })],
    })
    assert.deepStrictEqual(idsOf(issueOf(evaluation.warnings, "portions_left")), [8])
    assert.deepStrictEqual(idsOf(issueOf(evaluation.warnings, "cooked_not_eaten")), [8])
  })
})

describe("evaluatePlan: too_many_days (E)", () => {
  // Dish 1 on the days 0, 1 and 2; dish 3 only on day 3.
  const meals = withMeal(2, "lunch", [1])
  const dishes = { 1: { enrichment: servings(12, 12) } }

  it("fires for a dish that is eaten on more than maxDaysPerDish distinct days", () => {
    const issue = issueOf(evaluate({ meals, dishes, household: { maxDaysPerDish: 2 } }).errors, "too_many_days")
    assert.deepStrictEqual(idsOf(issue), [1])
    assert.deepStrictEqual(issue.days, [0, 1, 2])
  })

  it("does not fire for exactly maxDaysPerDish days", () => {
    assert.notInclude(codes(evaluate({ meals, dishes }).errors), "too_many_days")
  })

  it("counts days, not slots", () => {
    // Dish 1 on the lunch and the dinner of the same day is 1 day.
    const sameDay = withMeal(0, "dinner", [1])
    assert.notInclude(
      codes(evaluate({ meals: sameDay, dishes, household: { maxDaysPerDish: 2 } }).errors),
      "too_many_days"
    )
  })
})

describe("evaluatePlan: same_day_twice (W)", () => {
  it("fires for a dish at lunch and dinner of the same day", () => {
    const evaluation = evaluate({
      meals: withMeal(0, "dinner", [1]),
      dishes: { 1: { enrichment: servings(12, 12) } },
    })
    const issue = issueOf(evaluation.warnings, "same_day_twice")
    assert.deepStrictEqual(idsOf(issue), [1])
    assert.deepStrictEqual(issue.days, [0])
  })

  it("does not fire for a dish on different days", () => {
    assert.notInclude(codes(evaluate().warnings), "same_day_twice")
  })
})

describe("evaluatePlan: not_fresh (E)", () => {
  // Dish 3 is cooked on day 0 and eaten on the days 2 and 3.
  it("fires when the day eaten minus the session day is more than fridgeDays", () => {
    const issue = issueOf(evaluate({ dishes: { 3: { enrichment: { fridgeDays: 2 } } } }).errors, "not_fresh")
    assert.deepStrictEqual(idsOf(issue), [3])
    assert.deepStrictEqual(issue.days, [3])
  })

  it("does not fire when the gap equals fridgeDays", () => {
    assert.notInclude(codes(evaluate({ dishes: { 3: { enrichment: { fridgeDays: 3 } } } }).errors), "not_fresh")
  })

  it("measures from the session day, not from the first day of the week", () => {
    // Dish 5 is cooked on day 4 and eaten on the days 4 and 5: the gap is 1, though the day number is 5.
    assert.notInclude(codes(evaluate({ dishes: { 5: { enrichment: { fridgeDays: 1 } } } }).errors), "not_fresh")
    assert.deepStrictEqual(
      issueOf(evaluate({ dishes: { 5: { enrichment: { fridgeDays: 0 } } } }).errors, "not_fresh").days,
      [5]
    )
  })

  it("is capped by fridgeDaysCap", () => {
    const dishes = { 3: { enrichment: { fridgeDays: 4 } } }
    assert.notInclude(codes(evaluate({ dishes }).errors), "not_fresh")
    assert.deepStrictEqual(issueOf(evaluate({ dishes, household: { fridgeDaysCap: 2 } }).errors, "not_fresh").days, [3])
  })
})

describe("evaluatePlan: heat (E/W)", () => {
  const heat = (level: 0 | 1 | 2 | 3) => ({
    2: { enrichment: { heat: level } },
  })

  it("is an error above maxHeat", () => {
    const evaluation = evaluate({ dishes: heat(3) })
    assert.deepStrictEqual(idsOf(issueOf(evaluation.errors, "heat")), [2])
    assert.notInclude(codes(evaluation.warnings), "heat")
  })

  it("is a warning at maxHeat", () => {
    const evaluation = evaluate({ dishes: heat(2) })
    assert.deepStrictEqual(idsOf(issueOf(evaluation.warnings, "heat")), [2])
    assert.notInclude(codes(evaluation.errors), "heat")
    assert.isTrue(evaluation.ok)
  })

  it("is silent below maxHeat", () => {
    const evaluation = evaluate({ dishes: heat(1) })
    assert.notInclude(codes(evaluation.errors), "heat")
    assert.notInclude(codes(evaluation.warnings), "heat")
  })

  it("follows maxHeat of the household, and a dish without heat is never a warning", () => {
    assert.notInclude(codes(evaluate({ dishes: heat(3), household: { maxHeat: 3 } }).errors), "heat")
    assert.include(codes(evaluate({ dishes: heat(3), household: { maxHeat: 3 } }).warnings), "heat")
    const none = evaluate({ household: { maxHeat: 0 } })
    assert.notInclude(codes(none.warnings), "heat")
  })
})

describe("evaluatePlan: equipment (E)", () => {
  it("fires for equipment outside the household, and names it", () => {
    const evaluation = evaluate({
      dishes: { 4: { enrichment: { equipment: ["hob", "grill", "special"] } } },
    })
    const issue = issueOf(evaluation.errors, "equipment")
    assert.deepStrictEqual(idsOf(issue), [4])
    assert.include(issue.message, "grill")
    assert.include(issue.message, "special")
    assert.notInclude(issue.message, "hob")
  })

  it("does not fire for equipment that the household has", () => {
    const evaluation = evaluate({
      dishes: {
        4: {
          enrichment: {
            equipment: ["hob", "oven", "air_fryer", "immersion_blender"],
          },
        },
      },
    })
    assert.notInclude(codes(evaluation.errors), "equipment")
  })

  it("follows the list of the household", () => {
    const dishes = { 4: { enrichment: { equipment: ["grill" as const] } } }
    assert.include(codes(evaluate({ dishes }).errors), "equipment")
    assert.notInclude(
      codes(
        evaluate({
          dishes,
          household: { equipment: [...DEFAULT_HOUSEHOLD.equipment, "grill"] },
        }).errors
      ),
      "equipment"
    )
  })
})

describe("evaluatePlan: active_time (W)", () => {
  it("fires when the sum of a session is more than activeMinutesPerSession", () => {
    // Session A: 4 dishes of 40 minutes = 160.
    const dishes = Object.fromEntries([1, 2, 3, 4].map((n) => [n, { enrichment: { activeMinutes: 40 } }]))
    const evaluation = evaluate({ dishes })
    const issue = issueOf(evaluation.warnings, "active_time")
    assert.deepStrictEqual(issue.days, [0])
    assert.deepStrictEqual(idsOf(issue), [1, 2, 3, 4])
    assert.strictEqual(evaluation.metrics.activeMinutes[0]?.minutes, 160)
    assert.deepStrictEqual(evaluation.metrics.activeMinutes[1], {
      session: "B",
      minutes: 60,
    })
  })

  it("does not fire for exactly activeMinutesPerSession", () => {
    const dishes = {
      1: { enrichment: { activeMinutes: 50 } },
      2: { enrichment: { activeMinutes: 50 } },
      3: { enrichment: { activeMinutes: 50 } },
      4: { enrichment: { activeMinutes: 0 } },
    }
    assert.notInclude(codes(evaluate({ dishes }).warnings), "active_time")
    const over = { ...dishes, 4: { enrichment: { activeMinutes: 1 } } }
    assert.include(codes(evaluate({ dishes: over }).warnings), "active_time")
  })

  it("multiplies by 1 up to scale 1.5 and by 1.25 above", () => {
    // Dish 1 takes 80 minutes; the other dishes of session A take 60.
    const dishes = { 1: { enrichment: { activeMinutes: 80 } } }
    const small = evaluate({ dishes, cooking: scaled(1, 1.5) })
    assert.strictEqual(small.metrics.activeMinutes[0]?.minutes, 140)
    assert.notInclude(codes(small.warnings), "active_time")
    const big = evaluate({ dishes, cooking: scaled(1, 2) })
    assert.strictEqual(big.metrics.activeMinutes[0]?.minutes, 160)
    assert.include(codes(big.warnings), "active_time")
  })

  it("counts each session on its own", () => {
    const dishes = Object.fromEntries([5, 6, 7].map((n) => [n, { enrichment: { activeMinutes: 60 } }]))
    const issue = issueOf(evaluate({ dishes }).warnings, "active_time")
    assert.deepStrictEqual(issue.days, [4])
    assert.deepStrictEqual(idsOf(issue), [5, 6, 7])
  })
})

describe("evaluatePlan: long_wait (E/W)", () => {
  const wait = (hours: number | null) => ({
    6: { enrichment: { longWaitHours: hours } },
  })

  it("is an error above longWaitHoursMax", () => {
    const evaluation = evaluate({ dishes: wait(13) })
    assert.deepStrictEqual(idsOf(issueOf(evaluation.errors, "long_wait")), [6])
    assert.notInclude(codes(evaluation.warnings), "long_wait")
  })

  it("is a warning for any wait up to longWaitHoursMax", () => {
    for (const hours of [0.5, 8, 12]) {
      const evaluation = evaluate({ dishes: wait(hours) })
      assert.deepStrictEqual(idsOf(issueOf(evaluation.warnings, "long_wait")), [6])
      assert.notInclude(codes(evaluation.errors), "long_wait")
    }
  })

  it("is silent without a wait", () => {
    for (const hours of [null, 0]) {
      const evaluation = evaluate({ dishes: wait(hours) })
      assert.notInclude(codes(evaluation.errors), "long_wait")
      assert.notInclude(codes(evaluation.warnings), "long_wait")
    }
  })
})

describe("evaluatePlan: protein_families (E/W)", () => {
  it("is silent for 1 family, and for a vegetarian week", () => {
    const vegetarian = Object.fromEntries(
      [1, 2, 7].map((n) => [n, { enrichment: { proteinFamilies: [], vegetarian: true } }])
    )
    const evaluation = evaluate({ dishes: vegetarian })
    assert.deepStrictEqual(evaluation.metrics.proteinFamilies, [])
    assert.notInclude(codes(evaluation.warnings), "protein_families")
    assert.notInclude(codes(evaluate().warnings), "protein_families")
  })

  it("is a warning for 2 families", () => {
    const evaluation = evaluate({
      dishes: {
        3: { enrichment: { proteinFamilies: ["beef"], vegetarian: false } },
      },
    })
    const issue = issueOf(evaluation.warnings, "protein_families")
    assert.deepStrictEqual(idsOf(issue), [1, 2, 3, 7])
    assert.deepStrictEqual(evaluation.metrics.proteinFamilies, ["chicken", "beef"])
    assert.notInclude(codes(evaluation.errors), "protein_families")
  })

  it("is an error for more families than maxProteinFamilies", () => {
    const dishes = {
      3: {
        enrichment: { proteinFamilies: ["beef" as const], vegetarian: false },
      },
      5: {
        enrichment: { proteinFamilies: ["fish" as const], vegetarian: false },
      },
    }
    const evaluation = evaluate({ dishes })
    assert.include(codes(evaluation.errors), "protein_families")
    assert.notInclude(codes(evaluation.warnings), "protein_families")
    assert.notInclude(codes(evaluate({ dishes, household: { maxProteinFamilies: 3 } }).errors), "protein_families")
  })

  it("counts a dish with 2 families once for each family", () => {
    const evaluation = evaluate({
      dishes: {
        3: {
          enrichment: {
            proteinFamilies: ["chicken", "pork"],
            vegetarian: false,
          },
        },
      },
    })
    assert.deepStrictEqual(evaluation.metrics.proteinFamilies, ["chicken", "pork"])
  })
})

describe("evaluatePlan: recent_repeat (W)", () => {
  const past = (weekStart: string, recipeIds: ReadonlyArray<number>): WeekPlan =>
    planOf({
      weekStart,
      cooking: recipeIds.map((recipeId) => ({
        session: "A" as const,
        recipeId,
      })),
      meals: [{ day: 0, meal: "lunch", recipeIds: [...recipeIds] }],
    })

  it("fires for a recipe in a saved plan of the last recentWeeks weeks", () => {
    const evaluation = evaluate({ history: [past("2026-09-26", [3])] })
    const issue = issueOf(evaluation.warnings, "recent_repeat")
    assert.deepStrictEqual(idsOf(issue), [3])
    assert.include(issue.message, "2026-09-26")
    assert.isTrue(evaluation.ok)
  })

  it("counts exactly recentWeeks × 7 days back", () => {
    // The plan starts on 2026-10-17. 28 days earlier is 2026-09-19.
    assert.include(codes(evaluate({ history: [past("2026-09-19", [3])] }).warnings), "recent_repeat")
    assert.notInclude(codes(evaluate({ history: [past("2026-09-18", [3])] }).warnings), "recent_repeat")
    assert.notInclude(
      codes(
        evaluate({
          history: [past("2026-09-19", [3])],
          household: { recentWeeks: 3 },
        }).warnings
      ),
      "recent_repeat"
    )
  })

  it("does not fire for other recipes, for the same week, for a later week, or when recentWeeks is 0", () => {
    assert.notInclude(codes(evaluate({ history: [past("2026-09-26", [99])] }).warnings), "recent_repeat")
    assert.notInclude(codes(evaluate({ history: [past("2026-10-17", [3])] }).warnings), "recent_repeat")
    assert.notInclude(codes(evaluate({ history: [past("2026-10-24", [3])] }).warnings), "recent_repeat")
    assert.notInclude(
      codes(
        evaluate({
          history: [past("2026-10-10", [3])],
          household: { recentWeeks: 0 },
        }).warnings
      ),
      "recent_repeat"
    )
    assert.notInclude(codes(evaluate().warnings), "recent_repeat")
  })

  it("names every week that had the recipe", () => {
    const evaluation = evaluate({
      history: [past("2026-10-03", [3]), past("2026-09-26", [3, 4])],
    })
    const repeated = evaluation.warnings.filter((issue) => issue.code === "recent_repeat")
    assert.deepStrictEqual(repeated.map(idsOf), [[3], [4]])
    assert.include(repeated[0]?.message ?? "", "2026-09-26, 2026-10-03")
  })
})

describe("evaluatePlan: one pass", () => {
  it("reports every problem at once, with stable codes in the order of the table", () => {
    const evaluation = evaluate({
      cooking: [...BASE_COOKING.filter((entry) => entry.recipeId !== 4), { session: "A", recipeId: 99 }],
      meals: withMeal(0, "dinner", [2, 99]).filter((slot) => !(slot.day === 6 && slot.meal === "dinner")),
      dishes: {
        2: { enrichment: { heat: 3 } },
        3: { enrichment: { fridgeDays: 2, longWaitHours: 20 } },
      },
    })
    assert.deepStrictEqual(codes(evaluation.errors), [
      "unknown_recipe",
      "not_cooked",
      "slot_missing",
      "not_fresh",
      "heat",
      "long_wait",
    ])
    assert.isFalse(evaluation.ok)
    for (const issue of [...evaluation.errors, ...evaluation.warnings]) {
      assert.include(ISSUE_CODES, issue.code)
      assert.isAbove(issue.message.length, 10)
    }
  })

  it("is true for ok if there are only warnings", () => {
    const evaluation = evaluate({ dishes: { 2: { enrichment: { heat: 2 } } } })
    assert.isTrue(evaluation.ok)
    assert.deepStrictEqual(codes(evaluation.warnings), ["heat"])
  })

  it("does not crash on an empty plan", () => {
    const evaluation = evaluatePlan(planOf({ cooking: [], meals: [] }), baseCatalogue(), DEFAULT_HOUSEHOLD, [])
    assert.strictEqual(evaluation.errors.filter((issue) => issue.code === "slot_missing").length, 14)
    assert.strictEqual(evaluation.metrics.dishCount, 0)
    assert.strictEqual(evaluation.metrics.slotsCovered, 0)
  })
})

describe("evaluatePlan: every code of the table", () => {
  const past: WeekPlan = planOf({
    weekStart: "2026-10-10",
    cooking: [{ session: "A", recipeId: 3 }],
    meals: [{ day: 0, meal: "lunch", recipeIds: [3] }],
  })

  /** One scenario for each code, that triggers it. The type makes the table complete. */
  const TRIGGERS: Readonly<Record<IssueCode, Scenario>> = {
    unknown_recipe: {
      cooking: [...BASE_COOKING, { session: "A", recipeId: 99 }],
      meals: withMeal(0, "dinner", [2, 99]),
    },
    not_cooked: {
      cooking: BASE_COOKING.filter((entry) => entry.recipeId !== 4),
    },
    cooked_not_eaten: {
      cooking: [...BASE_COOKING, { session: "B", recipeId: 8 }],
      extra: [entryOf(8)],
    },
    slot_missing: {
      meals: BASE_MEALS.filter((slot) => !(slot.day === 3 && slot.meal === "dinner")),
    },
    slot_not_a_meal: {
      dishes: { 3: { enrichment: { mealFit: "needs_side" } } },
    },
    eaten_before_cooked: {
      cooking: BASE_COOKING.map((entry) => (entry.recipeId === 1 ? { ...entry, session: "B" } : entry)),
    },
    portions_short: { cooking: scaled(1, 0.5) },
    portions_tight: { dishes: { 1: { enrichment: servings(4, 8) } } },
    portions_left: { cooking: scaled(1, 2.5) },
    too_many_days: { household: { maxDaysPerDish: 1 } },
    same_day_twice: {
      meals: withMeal(0, "dinner", [1]),
      dishes: { 1: { enrichment: servings(12, 12) } },
    },
    not_fresh: { dishes: { 3: { enrichment: { fridgeDays: 2 } } } },
    heat: { dishes: { 2: { enrichment: { heat: 3 } } } },
    equipment: { dishes: { 4: { enrichment: { equipment: ["grill"] } } } },
    active_time: { household: { activeMinutesPerSession: 79 } },
    long_wait: { dishes: { 6: { enrichment: { longWaitHours: 13 } } } },
    protein_families: {
      dishes: {
        3: { enrichment: { proteinFamilies: ["beef"], vegetarian: false } },
      },
    },
    recent_repeat: { history: [past] },
    dish_type_excluded: { household: prefs({ excludedDishTypes: ["soup"] }) },
    side_repeated: {
      household: prefs({ sideGroups: { рис: ["рис"] } }),
      dishes: { 2: { ingredients: [inGrams("рис", 200)] } },
    },
    heavy_dinner: { household: prefs({ dinnerAvoidItems: ["сметана"] }) },
    item_limit: {
      household: prefs({
        itemLimits: [{ name: "рис", items: ["рис"], maxDishes: 0 }],
      }),
    },
    low_protein: { protein: { соль: 0 } },
    fresh_time: {
      cooking: [...BASE_COOKING, { session: "fresh", recipeId: 8 }],
      meals: [...BASE_MEALS, { day: 0, meal: "breakfast", recipeIds: [8] }],
      extra: [FRESH(8, { activeMinutes: 30 })],
    },
    fresh_not_breakfast: {
      cooking: BASE_COOKING.map((entry) => (entry.recipeId === 1 ? { ...entry, session: "fresh" } : entry)),
    },
    unknown_simple: {
      meals: [...BASE_MEALS, { day: 0, meal: "breakfast", recipeIds: [], simpleIds: ["nope"] }],
    },
    simple_not_breakfast: {
      meals: withMeals({
        day: 0,
        meal: "lunch",
        recipeIds: [1],
        simpleIds: ["yogurt"],
      }),
      simple: [YOGURT],
    },
    breakfast_only_recipe: {
      cooking: [...BASE_COOKING, { session: "A", recipeId: 8 }],
      meals: withMeal(0, "lunch", [1, 8]),
      extra: [BREAKFAST_ONLY(8)],
    },
  }

  it("is triggered by its scenario, as an error or as a warning", () => {
    for (const code of ISSUE_CODES) {
      const evaluation = evaluate(TRIGGERS[code])
      assert.include(codes([...evaluation.errors, ...evaluation.warnings]), code, `scenario of ${code}`)
    }
  })

  it("is not triggered by the base week", () => {
    const evaluation = evaluate()
    for (const code of ISSUE_CODES) {
      assert.notInclude(codes([...evaluation.errors, ...evaluation.warnings]), code, `base week and ${code}`)
    }
  })
})

describe("evaluatePlan: taste rules (spec P4.8)", () => {
  const DISH_2_BASE = inGrams("куриные бёдра", 800, { category: "poultry" })
  /** Dish 2 (dinner on days 0 and 1) with an extra ingredient. */
  const dish2With = (...extra: ReadonlyArray<ReturnType<typeof inGrams>>): NonNullable<Scenario["dishes"]> => ({
    2: { ingredients: [DISH_2_BASE, ...extra] },
  })
  const SIDES = {
    картофель: ["картофель"],
    макароны: ["макароны"],
    рис: ["рис"],
  }

  it("finds nothing without preferences, also for a week that repeats the same side", () => {
    const evaluation = evaluate({
      dishes: dish2With(inGrams("картофель", 300), inGrams("рис", 300), inGrams("сосиски", 200)),
    })
    assert.deepStrictEqual(codes([...evaluation.errors, ...evaluation.warnings]), [])
  })

  describe("dish_type_excluded", () => {
    it("is an error for each cooked dish of an excluded type", () => {
      const evaluation = evaluate({
        household: prefs({ excludedDishTypes: ["soup"] }),
      })
      assert.deepStrictEqual(codes(evaluation.errors), ["dish_type_excluded"])
      const issue = issueOf(evaluation.errors, "dish_type_excluded")
      assert.deepStrictEqual(idsOf(issue), [1])
      assert.deepStrictEqual(issue.days, [0, 1])
      assert.include(issue.message, "«Суп Альфа» (1)")
      assert.isFalse(evaluation.ok)
    })

    it("lists each dish of the types once", () => {
      const evaluation = evaluate({
        household: prefs({ excludedDishTypes: ["soup", "salad"] }),
      })
      assert.deepStrictEqual(evaluation.errors.map(idsOf), [[1], [4]])
    })

    it("does not fire for a type that the week does not have, or for a dish that is not cooked", () => {
      assert.deepStrictEqual(codes(evaluate({ household: prefs({ excludedDishTypes: ["sauce"] }) }).errors), [])
      const notCooked = evaluate({
        household: prefs({ excludedDishTypes: ["soup"] }),
        cooking: BASE_COOKING.filter((entry) => entry.recipeId !== 1),
      })
      assert.notInclude(codes(notCooked.errors), "dish_type_excluded")
    })
  })

  describe("side_repeated", () => {
    it("is 1 warning for a group that 2 cooked dishes have, with the IDs and the days", () => {
      const evaluation = evaluate({
        household: prefs({ sideGroups: SIDES }),
        dishes: dish2With(inGrams("картофель", 300)),
      })
      assert.deepStrictEqual(codes(evaluation.warnings), ["side_repeated"])
      const issue = issueOf(evaluation.warnings, "side_repeated")
      assert.deepStrictEqual(idsOf(issue), [1, 2])
      assert.deepStrictEqual(issue.days, [0, 1])
      assert.include(issue.message, "«картофель»")
      assert.isTrue(evaluation.ok)
    })

    it("does not fire for 1 dish per group", () => {
      assert.deepStrictEqual(codes(evaluate({ household: prefs({ sideGroups: SIDES }) }).warnings), [])
    })

    it("gives 1 warning for each repeated group", () => {
      const evaluation = evaluate({
        household: prefs({ sideGroups: SIDES }),
        dishes: dish2With(inGrams("картофель", 300), inGrams("рис", 300)),
      })
      assert.deepStrictEqual(
        evaluation.warnings.map((issue) => idsOf(issue)),
        [
          [1, 2],
          [2, 3],
        ]
      )
    })

    it("counts the grams at the boundary: sideMinGrams itself counts, less does not", () => {
      const household = prefs({ sideGroups: SIDES, sideMinGrams: 100 })
      assert.deepStrictEqual(codes(evaluate({ household, dishes: dish2With(inGrams("картофель", 100)) }).warnings), [
        "side_repeated",
      ])
      assert.deepStrictEqual(codes(evaluate({ household, dishes: dish2With(inGrams("картофель", 99)) }).warnings), [])
    })

    it("counts an ingredient with unknown grams", () => {
      const evaluation = evaluate({
        household: prefs({ sideGroups: SIDES }),
        dishes: dish2With(ing("картофель")),
      })
      assert.deepStrictEqual(codes(evaluation.warnings), ["side_repeated"])
    })

    it("ignores pantry and optional ingredients", () => {
      const household = prefs({ sideGroups: SIDES })
      assert.deepStrictEqual(
        codes(
          evaluate({
            household,
            dishes: dish2With(inGrams("картофель", 300, { pantry: true })),
          }).warnings
        ),
        []
      )
      assert.deepStrictEqual(
        codes(
          evaluate({
            household,
            dishes: dish2With(inGrams("картофель", 300, { optional: true })),
          }).warnings
        ),
        []
      )
    })

    it("matches the names of the config through the alias map", () => {
      const household = prefs({ sideGroups: { картофель: ["Картошка"] } })
      const dishes = dish2With(inGrams("картофель", 300))
      assert.deepStrictEqual(codes(evaluate({ household, dishes }).warnings), [])
      const aliases = makeAliases({ картошка: "картофель" })
      assert.deepStrictEqual(codes(evaluate({ household, dishes, aliases }).warnings), ["side_repeated"])
    })

    it("matches the names of the catalogue through the alias map too", () => {
      const aliases = makeAliases({ картошка: "картофель" })
      const household = prefs({ sideGroups: { картофель: ["картофель"] } })
      const evaluation = evaluate({
        household,
        dishes: dish2With(inGrams("картошка", 300)),
        aliases,
      })
      assert.deepStrictEqual(codes(evaluation.warnings), ["side_repeated"])
    })
  })

  describe("heavy_dinner", () => {
    const household = prefs({
      sideGroups: SIDES,
      dinnerAvoidSideGroups: ["макароны", "рис"],
    })

    it("is a warning for a dish with a heavy side group in a dinner slot", () => {
      // Dish 6 (pasta): lunch on day 5, dinner on day 6.
      const evaluation = evaluate({ household })
      assert.deepStrictEqual(codes(evaluation.warnings), ["heavy_dinner"])
      const issue = issueOf(evaluation.warnings, "heavy_dinner")
      assert.deepStrictEqual(idsOf(issue), [6])
      assert.deepStrictEqual(issue.days, [6])
      assert.include(issue.message, "гарнир «макароны»")
    })

    it("does not fire for a lunch only: dish 3 (rice) is at lunch", () => {
      const lunchOnly = evaluate({
        household: prefs({ sideGroups: SIDES, dinnerAvoidSideGroups: ["рис"] }),
      })
      assert.deepStrictEqual(codes(lunchOnly.warnings), [])
    })

    it("does not fire for a side group that is not in dinnerAvoidSideGroups", () => {
      assert.deepStrictEqual(
        codes(
          evaluate({
            household: prefs({
              sideGroups: SIDES,
              dinnerAvoidSideGroups: ["картофель"],
            }),
          }).warnings
        ),
        []
      )
    })

    it("fires for an item in dinnerAvoidItems, 1 warning for each dish, with the dinner days", () => {
      const evaluation = evaluate({
        household: prefs({ dinnerAvoidItems: ["сметана"] }),
      })
      // Dish 2 has «сметана» (dinner on days 0 and 1), dish 4 too (dinner on days 2 and 3).
      assert.deepStrictEqual(
        evaluation.warnings.map((issue) => [issue.code, idsOf(issue), issue.days]),
        [
          ["heavy_dinner", [2], [0, 1]],
          ["heavy_dinner", [4], [2, 3]],
        ]
      )
      assert.include(evaluation.warnings[0]?.message ?? "", "продукт «сметана»")
    })

    it("lists only the dinner days of a dish that is at lunch and at dinner", () => {
      const evaluation = evaluate({
        household: prefs({ dinnerAvoidItems: ["макароны"] }),
      })
      assert.deepStrictEqual(
        evaluation.warnings.map((issue) => issue.days),
        [[6]]
      )
    })

    it("ignores an optional item", () => {
      // «сыр» is optional in dish 6.
      assert.deepStrictEqual(codes(evaluate({ household: prefs({ dinnerAvoidItems: ["сыр"] }) }).warnings), [])
    })

    it("honours sideMinGrams and the alias map", () => {
      const aliases = makeAliases({ спагетти: "макароны" })
      const small = prefs({
        sideGroups: { макароны: ["Спагетти"] },
        dinnerAvoidSideGroups: ["макароны"],
        sideMinGrams: 401,
      })
      assert.deepStrictEqual(codes(evaluate({ household: small, aliases }).warnings), [])
      const enough = prefs({
        sideGroups: { макароны: ["Спагетти"] },
        dinnerAvoidSideGroups: ["макароны"],
        sideMinGrams: 400,
      })
      assert.deepStrictEqual(codes(evaluate({ household: enough, aliases }).warnings), ["heavy_dinner"])
    })
  })

  describe("item_limit", () => {
    const limit = (maxDishes: number, items: ReadonlyArray<string> = ["рис"]) =>
      prefs({ itemLimits: [{ name: "рис", items, maxDishes }] })

    it("is 1 warning when more dishes than maxDishes have the item", () => {
      const evaluation = evaluate({
        household: limit(1),
        dishes: dish2With(inGrams("рис", 50)),
      })
      assert.deepStrictEqual(codes(evaluation.warnings), ["item_limit"])
      const issue = issueOf(evaluation.warnings, "item_limit")
      assert.deepStrictEqual(idsOf(issue), [2, 3])
      assert.deepStrictEqual(issue.days, [0, 1, 2, 3])
      assert.include(issue.message, "«рис»")
    })

    it("does not fire at the limit", () => {
      assert.deepStrictEqual(codes(evaluate({ household: limit(1) }).warnings), [])
      assert.deepStrictEqual(
        codes(
          evaluate({
            household: limit(2),
            dishes: dish2With(inGrams("рис", 50)),
          }).warnings
        ),
        []
      )
    })

    it("counts the dishes that have any item of the list, a dish once", () => {
      // Dish 3 has «рис», dish 6 has «макароны»; dish 2 has both.
      const both = limit(2, ["рис", "макароны"])
      assert.deepStrictEqual(codes(evaluate({ household: both }).warnings), [])
      const withDish2 = evaluate({
        household: both,
        dishes: dish2With(inGrams("рис", 50), inGrams("макароны", 50)),
      })
      assert.deepStrictEqual(idsOf(issueOf(withDish2.warnings, "item_limit")), [2, 3, 6])
    })

    it("ignores pantry and optional items, and maps the names through the aliases", () => {
      assert.deepStrictEqual(
        codes(
          evaluate({
            household: limit(1),
            dishes: dish2With(inGrams("рис", 50, { optional: true })),
          }).warnings
        ),
        []
      )
      const aliases = makeAliases({ "рис круглозерный": "рис" })
      const evaluation = evaluate({
        household: limit(1, ["Рис круглозерный"]),
        dishes: dish2With(inGrams("рис", 50)),
        aliases,
      })
      assert.deepStrictEqual(codes(evaluation.warnings), ["item_limit"])
    })

    it("gives 1 warning for each limit", () => {
      const household = prefs({
        itemLimits: [
          { name: "рис", items: ["рис"], maxDishes: 0 },
          { name: "макароны", items: ["макароны"], maxDishes: 0 },
        ],
      })
      assert.deepStrictEqual(evaluate({ household }).warnings.map(idsOf), [[3], [6]])
    })
  })
})

describe("evaluatePlan: Russian messages", () => {
  it("names the dish with title and ID, and the day with its weekday", () => {
    const missing = issueOf(
      evaluate({
        meals: BASE_MEALS.filter((slot) => !(slot.day === 4 && slot.meal === "lunch")),
      }).errors,
      "slot_missing"
    )
    // 2026-10-17 is a Saturday, so day 4 is Wednesday.
    assert.strictEqual(missing.message, "Не заполнен слот: день 4 (среда), обед.")
    const heat = issueOf(evaluate({ dishes: { 2: { enrichment: { heat: 3 } } } }).errors, "heat")
    assert.strictEqual(heat.message, "«Рагу Браво» (2): острота 3, а допустимо не больше 2.")
  })
})

describe("evaluatePlan: protein (spec P7.1)", () => {
  /** Chicken 20 g/100 g gives dish 1 (500 g, 7 portions) 14.3 g and dish 2 (800 g) 22.9 g per portion. */
  const PROTEIN = {
    "куриное филе": 20,
    "куриные бёдра": 20,
    яйца: 12.5,
    творог: 16,
    макароны: 12,
  }
  const low = (evaluation: PlanEvaluation) => evaluation.warnings.filter((issue) => issue.code === "low_protein")

  it("is off with an empty table, and the metric is still there", () => {
    const evaluation = evaluate()
    assert.deepStrictEqual(low(evaluation), [])
    assert.strictEqual(evaluation.metrics.proteinPerSlot.length, 14)
  })

  it("reports the protein of each slot, the sum of its dishes, sorted by day and meal", () => {
    const evaluation = evaluate({
      protein: PROTEIN,
      meals: withMeal(0, "lunch", [1, 2]),
    })
    const slots = evaluation.metrics.proteinPerSlot
    assert.deepStrictEqual(
      slots.slice(0, 3).map((slot) => [slot.day, slot.meal]),
      [
        [0, "lunch"],
        [0, "dinner"],
        [1, "lunch"],
      ]
    )
    assert.strictEqual(slots[0]?.grams, 37.2)
    assert.strictEqual(slots[1]?.grams, 22.9)
  })

  it("warns 1 time for a dish set and meal, with the days", () => {
    const evaluation = evaluate({ protein: PROTEIN })
    const warnings = low(evaluation)
    const soup = warnings.find((issue) => idsOf(issue).join() === "1")
    assert.deepStrictEqual(soup?.days, [0, 1])
    assert.include(soup?.message ?? "", "14,3 г")
    assert.include(soup?.message ?? "", "обед")
    assert.notInclude(soup?.message ?? "", "неточная")
    assert.isTrue(evaluation.ok)
  })

  it("does not warn when the protein reaches the minimum", () => {
    const evaluation = evaluate({
      protein: PROTEIN,
      household: { proteinMinGrams: { breakfast: 15, lunch: 14, dinner: 20 } },
    })
    assert.notInclude(
      low(evaluation).map((issue) => idsOf(issue).join()),
      "1"
    )
  })

  it("groups slots with the same dishes in a different order", () => {
    const evaluation = evaluate({
      protein: { соль: 0 },
      meals: [
        ...BASE_MEALS.filter((slot) => slot.day > 1),
        { day: 0, meal: "lunch", recipeIds: [1, 2] },
        { day: 1, meal: "lunch", recipeIds: [2, 1] },
      ],
    })
    const pair = low(evaluation).filter((issue) => idsOf(issue).join() === "1,2")
    assert.strictEqual(pair.length, 1)
    assert.deepStrictEqual(pair[0]?.days, [0, 1])
  })

  it("says that the estimate is uncertain if the coverage of a dish is below 0.7", () => {
    const evaluation = evaluate({ protein: { "куриные бёдра": 20 } })
    const soup = low(evaluation).find((issue) => idsOf(issue).join() === "1")
    assert.include(soup?.message ?? "", "Оценка неточная")
    assert.include(soup?.message ?? "", "покрытие 0%")
  })
})

describe("evaluatePlan: breakfasts (spec P7.2)", () => {
  const BREAKFAST: Partial<Household> = {
    meals: ["breakfast", "lunch", "dinner"],
    mealPersons: { breakfast: 2 },
  }
  const morning = (simpleIds: ReadonlyArray<string> = ["yogurt"], recipeIds: ReadonlyArray<number> = []): Slots =>
    Array.from({ length: 7 }, (_, day) => ({
      day,
      meal: "breakfast" as const,
      recipeIds,
      simpleIds,
    }))
  const withBreakfast = (scenario: Scenario = {}): Scenario => ({
    household: BREAKFAST,
    simple: [YOGURT],
    meals: [...BASE_MEALS, ...morning()],
    ...scenario,
  })

  it("has no error and no warning in a week with a simple breakfast every day", () => {
    const evaluation = evaluate(withBreakfast())
    assert.deepStrictEqual(codes(evaluation.errors), [])
    assert.deepStrictEqual(codes(evaluation.warnings), [])
    assert.strictEqual(evaluation.metrics.slotsRequired, 21)
    assert.strictEqual(evaluation.metrics.slotsCovered, 21)
  })

  it("keeps an old household without breakfast working: breakfast slots are not required, and not an error", () => {
    const evaluation = evaluate({
      simple: [YOGURT],
      meals: [...BASE_MEALS, ...morning()],
    })
    assert.deepStrictEqual(codes(evaluation.errors), [])
    assert.strictEqual(evaluation.metrics.slotsRequired, 14)
  })

  describe("slot_missing", () => {
    it("lists the 7 breakfast slots of a household with breakfast", () => {
      const missing = evaluate({ household: BREAKFAST }).errors.filter((issue) => issue.code === "slot_missing")
      assert.strictEqual(missing.length, 7)
      assert.include(missing[0]?.message ?? "", "завтрак")
    })

    it("does not list a breakfast slot that has only a simple breakfast", () => {
      assert.notInclude(codes(evaluate(withBreakfast()).errors), "slot_missing")
    })
  })

  describe("unknown_simple (E)", () => {
    it("names the ID and the days", () => {
      const issue = issueOf(
        evaluate(withBreakfast({ meals: [...BASE_MEALS, ...morning(["nope"])] })).errors,
        "unknown_simple"
      )
      assert.deepStrictEqual(issue.simpleIds, ["nope"])
      assert.deepStrictEqual(issue.days, [0, 1, 2, 3, 4, 5, 6])
    })

    it("does not fire for a known ID", () => {
      assert.notInclude(codes(evaluate(withBreakfast()).errors), "unknown_simple")
    })
  })

  describe("simple_not_breakfast (E)", () => {
    it("fires for a simple breakfast in a lunch slot", () => {
      const evaluation = evaluate(
        withBreakfast({
          meals: [
            ...BASE_MEALS.filter((slot) => !(slot.day === 2 && slot.meal === "lunch")),
            { day: 2, meal: "lunch", recipeIds: [3], simpleIds: ["yogurt"] },
            ...morning(),
          ],
        })
      )
      const issue = issueOf(evaluation.errors, "simple_not_breakfast")
      assert.deepStrictEqual(issue.simpleIds, ["yogurt"])
      assert.deepStrictEqual(issue.days, [2])
    })

    it("does not fire in a breakfast slot", () => {
      assert.notInclude(codes(evaluate(withBreakfast()).errors), "simple_not_breakfast")
    })
  })

  describe("fresh dishes", () => {
    const FRESH_COOKING: PlanSpec["cooking"] = [...BASE_COOKING, { session: "fresh", recipeId: 8 }]
    const freshWeek = (days: ReadonlyArray<number>, overrides: EnrichmentChange = {}): Scenario =>
      withBreakfast({
        cooking: FRESH_COOKING,
        meals: [
          ...BASE_MEALS,
          ...morning().map((slot) => (days.includes(slot.day) ? { ...slot, recipeIds: [8], simpleIds: [] } : slot)),
        ],
        extra: [FRESH(8, overrides)],
      })

    it("is allowed in breakfast slots, with no freshness limit, no session day and no session minutes", () => {
      // The dish is eaten on day 0 to 2. fridgeDays 1 would break `not_fresh` and the session day would break `eaten_before_cooked`.
      const evaluation = evaluate(freshWeek([0, 1, 2], { fridgeDays: 1 }))
      assert.deepStrictEqual(codes(evaluation.errors), [])
      assert.deepStrictEqual(codes(evaluation.warnings), [])
      assert.deepStrictEqual(evaluation.metrics.activeMinutes, [
        { session: "A", minutes: 80 },
        { session: "B", minutes: 60 },
      ])
    })

    it("judges the portions for the busiest day: 3 days of 2 portions are 2 portions", () => {
      const evaluation = evaluate(freshWeek([0, 1, 2]))
      const portions = evaluation.metrics.portions.find((item) => item.recipeId === 8)
      assert.deepStrictEqual(portions, {
        recipeId: 8,
        scale: 1,
        made: { min: 2, max: 4 },
        eaten: 2,
        left: { min: 0, max: 2 },
      })
    })

    it("raises portions_short if one cooking day is too small", () => {
      const issue = issueOf(
        evaluate(freshWeek([0, 1], { servings: { min: 1, max: 1, source: "page" } })).errors,
        "portions_short"
      )
      assert.deepStrictEqual(idsOf(issue), [8])
    })

    it("keeps too_many_days: a fresh dish also needs variety", () => {
      assert.include(codes(evaluate(freshWeek([0, 1, 2, 3])).errors), "too_many_days")
    })

    it("cooked_not_eaten: a fresh dish in no slot", () => {
      const evaluation = evaluate(withBreakfast({ cooking: FRESH_COOKING, extra: [FRESH(8)] }))
      assert.include(codes(evaluation.warnings), "cooked_not_eaten")
    })

    describe("fresh_time (W)", () => {
      it("fires when the active minutes of 1 day are more than freshMinutesMax, with the days", () => {
        const issue = issueOf(evaluate(freshWeek([0, 1], { activeMinutes: 21 })).warnings, "fresh_time")
        assert.deepStrictEqual(idsOf(issue), [8])
        assert.deepStrictEqual(issue.days, [0, 1])
        assert.strictEqual(
          codes(evaluate(freshWeek([0, 1], { activeMinutes: 21 })).warnings).filter((code) => code === "fresh_time")
            .length,
          1
        )
      })

      it("does not fire at exactly freshMinutesMax", () => {
        assert.notInclude(codes(evaluate(freshWeek([0, 1], { activeMinutes: 20 })).warnings), "fresh_time")
      })

      it("adds the fresh dishes of the same day", () => {
        const evaluation = evaluate(
          withBreakfast({
            cooking: [...FRESH_COOKING, { session: "fresh", recipeId: 9 }],
            meals: [...BASE_MEALS, { day: 0, meal: "breakfast", recipeIds: [8, 9] }, ...morning().slice(1)],
            extra: [FRESH(8, { activeMinutes: 12 }), FRESH(9, { activeMinutes: 12 })],
          })
        )
        const issue = issueOf(evaluation.warnings, "fresh_time")
        assert.deepStrictEqual(idsOf(issue), [8, 9])
      })

      it("uses the household key", () => {
        const scenario = freshWeek([0], { activeMinutes: 30 })
        assert.notInclude(
          codes(
            evaluate({
              ...scenario,
              household: { ...BREAKFAST, freshMinutesMax: 30 },
            }).warnings
          ),
          "fresh_time"
        )
      })
    })

    describe("fresh_not_breakfast (E)", () => {
      it("fires for a fresh dish in a lunch slot, with the days", () => {
        const evaluation = evaluate(
          withBreakfast({
            cooking: FRESH_COOKING,
            meals: [...withMeal(5, "dinner", [8]), ...morning()],
            extra: [FRESH(8)],
          })
        )
        const issue = issueOf(evaluation.errors, "fresh_not_breakfast")
        assert.deepStrictEqual(issue.days, [5])
      })

      it("does not fire in a breakfast slot", () => {
        assert.notInclude(codes(evaluate(freshWeek([0, 1])).errors), "fresh_not_breakfast")
      })
    })
  })

  describe("recipes of a breakfast", () => {
    it("breakfast_only_recipe: a not_a_meal recipe is fine at breakfast and an error at lunch", () => {
      const cooking: PlanSpec["cooking"] = [...BASE_COOKING, { session: "A", recipeId: 8 }]
      const atBreakfast = evaluate(
        withBreakfast({
          cooking,
          meals: [
            ...BASE_MEALS,
            ...morning().map((slot) => (slot.day < 2 ? { ...slot, recipeIds: [8], simpleIds: [] } : slot)),
          ],
          extra: [BREAKFAST_ONLY(8)],
        })
      )
      assert.deepStrictEqual(codes(atBreakfast.errors), [])
      const atLunch = evaluate(
        withBreakfast({
          cooking,
          meals: [...withMeal(0, "lunch", [1, 8]), ...morning()],
          extra: [BREAKFAST_ONLY(8)],
        })
      )
      assert.deepStrictEqual(idsOf(issueOf(atLunch.errors, "breakfast_only_recipe")), [8])
    })

    it("slot_not_a_meal does not judge a breakfast slot", () => {
      const cooking: PlanSpec["cooking"] = [...BASE_COOKING, { session: "A", recipeId: 8 }]
      const needy = entryOf(8, {
        enrichment: {
          mealFit: "needs_side",
          servings: { min: 6, max: 8, source: "page" },
        },
      })
      const evaluation = evaluate(
        withBreakfast({
          cooking,
          meals: [
            ...BASE_MEALS,
            ...morning().map((slot) => (slot.day < 2 ? { ...slot, recipeIds: [8], simpleIds: [] } : slot)),
          ],
          extra: [needy],
        })
      )
      assert.notInclude(codes(evaluation.errors), "slot_not_a_meal")
      // The same dish in a lunch slot is judged.
      const lunch = evaluate({
        cooking,
        meals: withMeal(0, "lunch", [8]),
        extra: [needy],
      })
      assert.include(codes(lunch.errors), "slot_not_a_meal")
    })

    it("counts 2 persons for a breakfast slot, 3 for the other meals", () => {
      const meals = withMeals({ day: 2, meal: "lunch", recipeIds: [1] })
      const scenario = withBreakfast({
        meals: [
          ...meals,
          ...morning().map((slot) => (slot.day === 5 ? { ...slot, recipeIds: [1], simpleIds: [] } : slot)),
        ],
      })
      const dish = (evaluation: PlanEvaluation) => evaluation.metrics.portions.find((item) => item.recipeId === 1)
      // Lunch on day 0, 1, 2 (3 × 3) and breakfast on day 5 (2).
      assert.strictEqual(dish(evaluate(scenario))?.eaten, 11)
      // A household without `mealPersons` counts 3.
      assert.strictEqual(dish(evaluate({ ...scenario, household: { meals: BREAKFAST.meals ?? [] } }))?.eaten, 12)
    })
  })

  describe("protein", () => {
    const PROTEIN = { "греческий йогурт": 9, мед: 0, яйца: 12.7, творог: 16 }
    const low = (evaluation: PlanEvaluation) => evaluation.warnings.filter((issue) => issue.code === "low_protein")

    it("takes the protein of a simple breakfast from the table: 200 g at 9 g/100 g is 18 g, above the minimum 15", () => {
      const evaluation = evaluate(withBreakfast({ protein: PROTEIN }))
      assert.strictEqual(evaluation.metrics.proteinPerSlot.find((slot) => slot.meal === "breakfast")?.grams, 18)
      assert.deepStrictEqual(
        low(evaluation).filter((issue) => issue.simpleIds.length > 0),
        []
      )
    })

    it("warns for a simple breakfast with little protein, with its ID", () => {
      const weak: SimpleBreakfast = {
        id: "weak",
        title: "Тост с джемом",
        items: [{ item: "хлеб", grams: 60, category: "bakery", pantry: false }],
      }
      const evaluation = evaluate(
        withBreakfast({
          protein: { ...PROTEIN, хлеб: 8 },
          simple: [YOGURT, weak],
          meals: [...BASE_MEALS, ...morning(["weak"])],
        })
      )
      const issue = low(evaluation).find((found) => found.simpleIds.includes("weak"))
      assert.deepStrictEqual(issue?.days, [0, 1, 2, 3, 4, 5, 6])
      assert.include(issue?.message ?? "", "завтрак")
      assert.include(issue?.message ?? "", "4,8 г")
    })

    it("adds the protein of the recipes and the simple breakfasts of a slot", () => {
      const weak: SimpleBreakfast = {
        id: "weak",
        title: "Тост с джемом",
        items: [{ item: "хлеб", grams: 60, category: "bakery", pantry: false }],
      }
      const meals = [
        ...BASE_MEALS,
        ...morning(["weak"]).map((slot) => (slot.day === 0 ? { ...slot, recipeIds: [8] } : slot)),
      ]
      const evaluation = evaluate(
        withBreakfast({
          protein: { ...PROTEIN, хлеб: 8 },
          simple: [YOGURT, weak],
          cooking: [...BASE_COOKING, { session: "fresh", recipeId: 8 }],
          meals,
          extra: [FRESH(8)],
        })
      )
      // Dish 8: 300 g × 16 / 100 + 110 g × 12.7 / 100 = 62 g for 3 portions (the middle of 2 and 4) = 20.7 g. Plus 4.8 g.
      assert.strictEqual(evaluation.metrics.proteinPerSlot[0]?.grams, 25.5)
      assert.strictEqual(evaluation.metrics.proteinPerSlot[0]?.meal, "breakfast")
    })
  })

  describe("metrics and taste rules", () => {
    it("counts the products of the simple breakfasts in buyItemCount and pantryItemCount", () => {
      const evaluation = evaluate(withBreakfast())
      assert.strictEqual(evaluation.metrics.buyItemCount, 15)
      assert.strictEqual(evaluation.metrics.pantryItemCount, 5)
    })

    it("item_limit counts a simple breakfast as a dish", () => {
      const sausage: SimpleBreakfast = {
        id: "sausage",
        title: "Бутерброд с колбасой",
        items: [{ item: "колбаса", grams: 50, category: "meat", pantry: false }],
      }
      const evaluation = evaluate(
        withBreakfast({
          simple: [YOGURT, sausage],
          meals: [...BASE_MEALS, ...morning(["sausage"])],
          household: {
            ...BREAKFAST,
            ...prefs({
              itemLimits: [{ name: "колбасные изделия", items: ["колбаса"], maxDishes: 0 }],
            }),
          },
        })
      )
      const issue = issueOf(evaluation.warnings, "item_limit")
      assert.deepStrictEqual(issue.simpleIds, ["sausage"])
    })

    it("side_repeated does not count a dish that is eaten only at breakfast", () => {
      const rice = (n: number) =>
        entryOf(n, {
          title: `Каша Лима ${n}`,
          enrichment: {
            mealFit: "full_meal",
            servings: { min: 2, max: 4, source: "page" },
          },
          ingredients: [inGrams("рис", 200, { category: "grain" })],
        })
      const household = {
        ...BREAKFAST,
        ...prefs({ sideGroups: { рис: ["рис"] } }),
      }
      const atBreakfast = evaluate(
        withBreakfast({
          household,
          cooking: [...BASE_COOKING, { session: "fresh", recipeId: 8 }],
          meals: [
            ...BASE_MEALS,
            ...morning().map((slot) => (slot.day === 0 ? { ...slot, recipeIds: [8], simpleIds: [] } : slot)),
          ],
          extra: [rice(8)],
        })
      )
      assert.notInclude(codes(atBreakfast.warnings), "side_repeated")
      // The same rice dish at lunch is counted.
      const atLunch = evaluate(
        withBreakfast({
          household,
          cooking: [...BASE_COOKING, { session: "A", recipeId: 8 }],
          meals: [...withMeal(0, "lunch", [8]), ...morning()],
          extra: [rice(8)],
        })
      )
      assert.include(codes(atLunch.warnings), "side_repeated")
    })
  })
})
