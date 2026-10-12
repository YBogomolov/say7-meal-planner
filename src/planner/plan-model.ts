import type { Catalogue, CatalogueEntry } from "../domain/catalogue.ts"
import type { MealName } from "../domain/household.ts"
import type { RecipeId } from "../domain/recipe.ts"
import type { CookingEntry, WeekPlan } from "../domain/week-plan.ts"

/** The order of the meals within a day. */
const MEAL_ORDER: ReadonlyArray<MealName> = ["lunch", "dinner"]

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

const compareSlots = (a: Slot, b: Slot): number =>
  a.day - b.day || MEAL_ORDER.indexOf(a.meal) - MEAL_ORDER.indexOf(b.meal)

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
