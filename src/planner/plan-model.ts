import type { Catalogue, CatalogueEntry } from "../domain/catalogue.ts"
import { MEAL_NAMES, personsOf } from "../domain/household.ts"
import type { Household, MealName, SessionId } from "../domain/household.ts"
import type { RecipeId } from "../domain/recipe.ts"
import type { SimpleBreakfast } from "../domain/simple-breakfast.ts"
import type { CookingEntry, WeekPlan } from "../domain/week-plan.ts"

/** The order of the meals within a day. */
const MEAL_ORDER: ReadonlyArray<MealName> = MEAL_NAMES

/** Order two meals of the same day: breakfast, lunch, dinner. */
export const compareMeals = (a: MealName, b: MealName): number => MEAL_ORDER.indexOf(a) - MEAL_ORDER.indexOf(b)

export interface Slot {
  readonly day: number
  readonly meal: MealName
}

/** One recipe of a plan, with everything that the plan and the catalogue say about it. */
export interface PlanDish {
  readonly recipeId: RecipeId
  /** `undefined` if the plan does not cook the dish. */
  readonly cooking: CookingEntry | undefined
  /** `undefined` if the catalogue does not have the recipe. */
  readonly entry: CatalogueEntry | undefined
  /** The slots with the dish, by day and meal. */
  readonly slots: ReadonlyArray<Slot>
  /** The distinct days with the dish, ascending. */
  readonly days: ReadonlyArray<number>
}

/** A dish that the plan cooks and the catalogue knows. */
export interface CookedDish extends PlanDish {
  readonly cooking: CookingEntry
  readonly entry: CatalogueEntry
}

export const isCooked = (dish: PlanDish): dish is CookedDish => dish.cooking !== undefined && dish.entry !== undefined

export const compareSlots = (a: Slot, b: Slot): number => a.day - b.day || compareMeals(a.meal, b.meal)

/** Is the dish fresh (spec P7.2.2): cooked on each day that it is eaten? */
export const isFresh = (dish: PlanDish): boolean => dish.cooking?.session === "fresh"

/** The session A or B of a cooking entry. `undefined` for a fresh dish: it has no session day. */
export const sessionIdOf = (cooking: CookingEntry): SessionId | undefined =>
  cooking.session === "fresh" ? undefined : cooking.session

/**
 * The portions that the persons eat from the slots (spec P7.2.2): the sum of `personsOf(meal)`.
 * `perDay` takes the busiest day instead of the sum: the portions of 1 cooking day of a fresh dish.
 */
export const portionsEaten = (slots: ReadonlyArray<Slot>, household: Household, perDay: boolean): number => {
  if (!perDay) {
    return slots.reduce((total, slot) => total + personsOf(household, slot.meal), 0)
  }
  const days = new Set(slots.map((slot) => slot.day))
  return Math.max(
    0,
    ...[...days].map((day) =>
      slots.filter((slot) => slot.day === day).reduce((total, slot) => total + personsOf(household, slot.meal), 0)
    )
  )
}

/** One simple breakfast of a plan (spec P7.2.3), with everything that the plan and the catalogue say about it. */
export interface PlanSimple {
  readonly simpleId: string
  /** `undefined` if `config/simple-breakfasts.json` does not have the ID. */
  readonly entry: SimpleBreakfast | undefined
  readonly slots: ReadonlyArray<Slot>
  readonly days: ReadonlyArray<number>
}

/** Every simple breakfast in `meals`, sorted by ID, each once. */
export const planSimples = (plan: WeekPlan, catalogue: Catalogue): ReadonlyArray<PlanSimple> => {
  const slotsOf = new Map<string, Array<Slot>>()
  for (const meal of plan.meals) {
    for (const simpleId of new Set(meal.simpleIds)) {
      slotsOf.set(simpleId, [...(slotsOf.get(simpleId) ?? []), { day: meal.day, meal: meal.meal }])
    }
  }
  return [...slotsOf.keys()].sort().map((simpleId): PlanSimple => {
    const slots = [...(slotsOf.get(simpleId) ?? [])].sort(compareSlots)
    return { simpleId, entry: catalogue.simpleById.get(simpleId), slots, days: [...new Set(slots.map((slot) => slot.day))] }
  })
}

/**
 * Every recipe in `cooking` or in `meals`, sorted by ID, each once.
 * A cooking entry that repeats a recipe (a plan that skipped the decoder) counts once, the first entry.
 */
export const planDishes = (plan: WeekPlan, catalogue: Catalogue): ReadonlyArray<PlanDish> => {
  const cookingOf = new Map<RecipeId, CookingEntry>()
  for (const entry of plan.cooking) {
    if (!cookingOf.has(entry.recipeId)) {
      cookingOf.set(entry.recipeId, entry)
    }
  }
  const slotsOf = new Map<RecipeId, Array<Slot>>()
  for (const meal of plan.meals) {
    for (const recipeId of new Set(meal.recipeIds)) {
      slotsOf.set(recipeId, [...(slotsOf.get(recipeId) ?? []), { day: meal.day, meal: meal.meal }])
    }
  }
  const ids = [...new Set([...cookingOf.keys(), ...slotsOf.keys()])].sort((a, b) => a - b)
  return ids.map((recipeId): PlanDish => {
    const slots = [...(slotsOf.get(recipeId) ?? [])].sort(compareSlots)
    return {
      recipeId,
      cooking: cookingOf.get(recipeId),
      entry: catalogue.byId.get(recipeId),
      slots,
      days: [...new Set(slots.map((slot) => slot.day))]
    }
  })
}
