import { Option, Result, Schema } from "effect"
import { parse } from "parse5"
import { PARSER_VERSION, ParsedRecipe, ParseError } from "../domain/parsed-recipe.ts"
import type { ParseFailureReason, WarningKind } from "../domain/parsed-recipe.ts"
import type { RecipeId } from "../domain/recipe.ts"
import { sha256Hex } from "../scraper/hash.ts"
import { parseAddedAt } from "./dates.ts"
import { byTag, findFirst, textOf } from "./dom.ts"
import type { Node } from "./dom.ts"
import { extractStepDurations, mentionsLongWait } from "./durations.ts"
import {
  extractCategories,
  extractCommentsCount,
  extractIngredientGroups,
  extractIntro,
  extractSimilarIds,
  extractSteps,
  extractTitle,
  extractUrl,
  extractYieldText,
  idFromUrl
} from "./extract.ts"
import { warningsOf } from "./report.ts"
import { findServingsText, parseServings } from "./servings.ts"

const decodeParsedRecipe = Schema.decodeUnknownResult(ParsedRecipe)

/** A parsed recipe and the warnings that the report counts for it. */
export interface ParseOutcome {
  readonly recipe: ParsedRecipe
  readonly warnings: ReadonlyArray<WarningKind>
}

/**
 * Parse the text of one recipe page of say7.info (spec P2).
 *
 * The function is pure. It fails with a `ParseError` when the page has no title, no canonical URL,
 * a canonical URL with another ID, no ingredient line or no step.
 * Missing optional data (servings, durations, date, …) is `null` or an empty list; the report counts it as a warning.
 *
 * `sourceSha256` is the SHA-256 of the UTF-8 encoding of `html`.
 * For a page that the scraper saved it is the hash of the file.
 */
export const parseRecipe = (html: string, id: RecipeId): Result.Result<ParsedRecipe, ParseError> =>
  parseRecipeWithWarnings(html, id).pipe(Result.map((outcome) => outcome.recipe))

/** Like `parseRecipe`, and also the warnings of the report (also those that the recipe alone does not show). */
export const parseRecipeWithWarnings = (html: string, id: RecipeId): Result.Result<ParseOutcome, ParseError> =>
  Result.gen(function*() {
    const fail = (reason: ParseFailureReason, message: string) => Result.fail(new ParseError({ id, reason, message }))

    const document = parse(html)
    const root: Node = findFirst(document, byTag("main")) ?? document

    const title = extractTitle(document)
    if (title === "") {
      return yield* fail("no_title", "The page has no <h1> with text")
    }

    const url = extractUrl(document)
    if (Option.isNone(url)) {
      return yield* fail("no_url", "The page has neither <link rel=\"canonical\"> nor <meta property=\"og:url\">")
    }
    const urlId = idFromUrl(url.value)
    if (Option.isNone(urlId) || urlId.value !== id) {
      return yield* fail(
        "id_mismatch",
        `The ID ${id} does not match the URL of the page: ${url.value}`
      )
    }

    const ingredientGroups = extractIngredientGroups(root)
    if (ingredientGroups.length === 0) {
      return yield* fail("no_ingredients", "The page has no ingredient line under the heading \"Ингредиенты\"")
    }

    const steps = extractSteps(root)
    if (steps.length === 0) {
      return yield* fail("no_steps", "The page has no step under the heading \"Приготовление\"")
    }

    const intro = extractIntro(root)
    const yieldText = extractYieldText(root)
    const servingsText = findServingsText({ yieldText, intro, steps })
    const durations = extractStepDurations(steps)
    const { categories, fromBreadcrumb } = extractCategories(document)

    const candidate = {
      parserVersion: PARSER_VERSION,
      id,
      url: url.value,
      title,
      intro,
      categories,
      ingredientGroups,
      steps,
      yieldText: Option.getOrNull(yieldText),
      servingsText: Option.getOrNull(servingsText),
      servings: Option.getOrNull(servingsText.pipe(Option.flatMap(parseServings))),
      durations,
      longWait: mentionsLongWait(steps, durations),
      addedAt: Option.getOrNull(parseAddedAt(textOf(root))),
      commentsCount: Option.getOrNull(extractCommentsCount(document)),
      similarIds: extractSimilarIds(document),
      sourceSha256: sha256Hex(new TextEncoder().encode(html))
    }

    const recipe = yield* decodeParsedRecipe(candidate).pipe(
      Result.mapError((error) => new ParseError({ id, reason: "invalid_output", message: error.message }))
    )
    return { recipe, warnings: warningsOf(recipe, { categoriesFromBreadcrumb: fromBreadcrumb }) }
  })
