import type { ParsedRecipe } from "../domain/parsed-recipe.ts"
import type { Household } from "../domain/household.ts"
import type { RecipeId } from "../domain/recipe.ts"

/**
 * Category IDs of the recipes that the enrichment covers (spec P3.1):
 * 40 Вторые блюда, 38 Салаты, 41 Закуски и бутерброды, 47 Первые блюда,
 * 44 Рыба и морепродукты, 48 Несладкая выпечка, 50 Блины, оладьи, сырники,
 * 233 Выпечка из творога (added in P7.2.5: breakfast candidates).
 * Desserts, cakes and sweet bakes are out of scope.
 */
export const SCOPE_CATEGORY_IDS: ReadonlySet<number> = new Set([40, 38, 41, 47, 44, 48, 50, 233])

/**
 * A recipe is in scope if at least 1 of its categories is in `SCOPE_CATEGORY_IDS`, or its ID is in `extraIds`
 * (spec P7.4.1: `household.breakfastExtraIds` and `household.lightDinnerIds`).
 */
export const isInScope = (
  recipe: Pick<ParsedRecipe, "id" | "categories">,
  extraIds: ReadonlySet<RecipeId> = new Set()
): boolean => extraIds.has(recipe.id) || recipe.categories.some((category) => SCOPE_CATEGORY_IDS.has(category.id))

/** The recipes that the household adds to the scope: `breakfastExtraIds` and `lightDinnerIds` (spec P7.4.1). */
export const extraScopeIds = (
  household: Pick<Household, "breakfastExtraIds" | "lightDinnerIds">
): ReadonlySet<RecipeId> => new Set([...household.breakfastExtraIds, ...household.lightDinnerIds])
