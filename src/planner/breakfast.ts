import type { ParsedRecipe } from "../domain/parsed-recipe.ts"
import type { RecipeId } from "../domain/recipe.ts"

/**
 * Category IDs of the breakfast candidates (spec P7.2.4):
 * 50 Блины, оладьи, сырники; 62 Закуски из яиц; 63 Бутерброды; 79 Рецепты запеканок; 233 Выпечка из творога.
 */
export const BREAKFAST_CATEGORY_IDS: ReadonlySet<number> = new Set([50, 62, 63, 79, 233])

/** A recipe is a breakfast candidate if a category is in `BREAKFAST_CATEGORY_IDS`, or its ID is in `extraIds` (`household.breakfastExtraIds`). */
export const isBreakfastEligible = (
  recipe: Pick<ParsedRecipe, "id" | "categories">,
  extraIds: ReadonlySet<RecipeId>
): boolean => extraIds.has(recipe.id) || recipe.categories.some((category) => BREAKFAST_CATEGORY_IDS.has(category.id))
