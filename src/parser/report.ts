import type { FailureReason, ParseReport } from "../domain/parse-report.ts"
import { PARSER_VERSION } from "../domain/parsed-recipe.ts"
import type { ParsedRecipe, WarningKind } from "../domain/parsed-recipe.ts"
import type { IsoTimestamp, RecipeId } from "../domain/recipe.ts"

/** What the parser knows about how it built a recipe, beyond the fields of the recipe. */
export interface ParseSignals {
  /** The categories come from the breadcrumb, because the page has no block "Категории рецепта". */
  readonly categoriesFromBreadcrumb: boolean
}

/**
 * The optional data that a parsed recipe lacks (spec P2, rule 2), and the data that comes from a fallback source.
 * A page with warnings is still a valid result.
 */
export const warningsOf = (recipe: ParsedRecipe, signals: ParseSignals): ReadonlyArray<WarningKind> => {
  const warnings: ReadonlyArray<readonly [boolean, WarningKind]> = [
    [recipe.intro.length === 0, "no_intro"],
    [recipe.servingsText === null, "no_servings"],
    [recipe.servingsText !== null && recipe.servings === null, "servings_unparsed"],
    [recipe.durations.length === 0, "no_durations"],
    [recipe.addedAt === null, "no_added_date"],
    [recipe.commentsCount === null, "no_comments_count"],
    [recipe.categories.length === 0, "no_categories"],
    [signals.categoriesFromBreadcrumb, "categories_from_breadcrumb"],
    [recipe.similarIds.length === 0, "no_similar"]
  ]
  return warnings.flatMap(([present, kind]) => (present ? [kind] : []))
}

/** The result for one page, as the report needs it. */
export type PageResult =
  | { readonly _tag: "Parsed"; readonly id: RecipeId; readonly warnings: ReadonlyArray<WarningKind> }
  | { readonly _tag: "Failed"; readonly id: RecipeId; readonly reason: FailureReason; readonly message: string }

/** Totals, failed pages and warning counts of a run (spec P2, rule 3). */
export const buildReport = (results: ReadonlyArray<PageResult>, generatedAt: IsoTimestamp): ParseReport => {
  const warningCounts: Record<WarningKind, number> = {
    no_intro: 0,
    no_servings: 0,
    servings_unparsed: 0,
    no_durations: 0,
    no_added_date: 0,
    no_comments_count: 0,
    no_categories: 0,
    categories_from_breadcrumb: 0,
    no_similar: 0
  }
  const warningIds: Record<WarningKind, Array<RecipeId>> = {
    no_intro: [],
    no_servings: [],
    servings_unparsed: [],
    no_durations: [],
    no_added_date: [],
    no_comments_count: [],
    no_categories: [],
    categories_from_breadcrumb: [],
    no_similar: []
  }
  const failed: Array<ParseReport["failed"][number]> = []
  let ok = 0
  let withWarnings = 0

  for (const result of results) {
    if (result._tag === "Failed") {
      failed.push({ id: result.id, reason: result.reason, message: result.message })
      continue
    }
    ok += 1
    if (result.warnings.length > 0) {
      withWarnings += 1
    }
    for (const kind of result.warnings) {
      warningCounts[kind] += 1
      warningIds[kind].push(result.id)
    }
  }

  return {
    version: 1,
    parserVersion: PARSER_VERSION,
    generatedAt,
    totals: { processed: results.length, ok, failed: failed.length, withWarnings },
    failed,
    warningCounts,
    warningIds
  }
}
