import type { ParsedRecipe } from "../domain/parsed-recipe.ts"

/**
 * Category IDs of the recipes that the enrichment covers (spec P3.1):
 * 40 Вторые блюда, 38 Салаты, 41 Закуски и бутерброды, 47 Первые блюда,
 * 44 Рыба и морепродукты, 48 Несладкая выпечка, 50 Блины, оладьи, сырники.
 * Desserts, cakes and sweet bakes are out of scope.
 */
export const SCOPE_CATEGORY_IDS: ReadonlySet<number> = new Set([40, 38, 41, 47, 44, 48, 50])

/** A recipe is in scope if at least 1 of its categories is in `SCOPE_CATEGORY_IDS`. */
export const isInScope = (recipe: Pick<ParsedRecipe, "categories">): boolean =>
  recipe.categories.some((category) => SCOPE_CATEGORY_IDS.has(category.id))
