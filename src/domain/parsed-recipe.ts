import { Schema } from "effect"
import { IsoDate, RecipeId } from "./recipe.ts"

/** Version of the parser output. Change it when the shape or the meaning of a field changes. */
export const PARSER_VERSION = 1

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

/** One category of a recipe, from a link `/cook/kitchen/<id>-<slug>/`. */
export const Category = Schema.Struct({
  id: PositiveInt,
  slug: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
})
export type Category = typeof Category.Type

/** Ingredient lines of one part of the recipe. `title` is `null` for the lines before the first heading. */
export const IngredientGroup = Schema.Struct({
  title: Schema.NullOr(Schema.NonEmptyString),
  items: Schema.Array(Schema.NonEmptyString).pipe(Schema.check(Schema.isNonEmpty())),
})
export type IngredientGroup = typeof IngredientGroup.Type

const minNotAboveMax = Schema.makeFilter<{
  readonly min: number
  readonly max: number
}>((range) => range.min <= range.max || "Expected min to be less than or equal to max")

/** Number of portions: `"6–8 порций"` is `{ min: 6, max: 8 }`, `"4 порции"` is `{ min: 4, max: 4 }`. */
export const Servings = Schema.Struct({
  min: PositiveInt,
  max: PositiveInt,
}).pipe(Schema.check(minNotAboveMax))
export type Servings = typeof Servings.Type

/** A time mention in a step. `text` is the matched fragment, for example `"40–50 минут"`. */
export const StepDuration = Schema.Struct({
  minMinutes: Schema.Natural,
  maxMinutes: Schema.Natural,
  text: Schema.NonEmptyString,
}).pipe(
  Schema.check(
    Schema.makeFilter<{
      readonly minMinutes: number
      readonly maxMinutes: number
    }>(
      (duration) =>
        duration.minMinutes <= duration.maxMinutes || "Expected minMinutes to be less than or equal to maxMinutes"
    )
  )
)
export type StepDuration = typeof StepDuration.Type

/** The result of `parseRecipe` for one page. Stored in `data/parsed/<id>.json`. */
export const ParsedRecipe = Schema.Struct({
  parserVersion: Schema.Literal(PARSER_VERSION),
  id: RecipeId,
  url: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  intro: Schema.Array(Schema.NonEmptyString),
  categories: Schema.Array(Category),
  ingredientGroups: Schema.Array(IngredientGroup).pipe(Schema.check(Schema.isNonEmpty())),
  steps: Schema.Array(Schema.NonEmptyString).pipe(Schema.check(Schema.isNonEmpty())),
  yieldText: Schema.NullOr(Schema.NonEmptyString),
  servingsText: Schema.NullOr(Schema.NonEmptyString),
  servings: Schema.NullOr(Servings),
  durations: Schema.Array(StepDuration),
  longWait: Schema.Boolean,
  addedAt: Schema.NullOr(IsoDate),
  commentsCount: Schema.NullOr(Schema.Natural),
  similarIds: Schema.Array(RecipeId),
  sourceSha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
})
export type ParsedRecipe = typeof ParsedRecipe.Type

/** JSON text codec for `data/parsed/<id>.json`. */
export const ParsedRecipeJson = Schema.fromJsonString(ParsedRecipe, {
  space: 2,
})

/** Why a page does not parse. */
export const ParseFailureReason = Schema.Literals([
  "no_title",
  "no_url",
  "id_mismatch",
  "no_ingredients",
  "no_steps",
  "invalid_output",
])
export type ParseFailureReason = typeof ParseFailureReason.Type

/** The page is not a usable recipe page: a required field is missing (spec P2, rule 2). */
export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  id: RecipeId,
  reason: ParseFailureReason,
  message: Schema.String,
}) {}

/**
 * Optional data that a page can lack, or data that the parser took from a fallback source.
 * The page still parses, and the report counts the warning.
 */
export const WarningKind = Schema.Literals([
  "no_intro",
  "no_servings",
  "servings_unparsed",
  "no_durations",
  "no_added_date",
  "no_comments_count",
  "no_categories",
  "categories_from_breadcrumb",
  "no_similar",
])
export type WarningKind = typeof WarningKind.Type

export const WARNING_KINDS: ReadonlyArray<WarningKind> = WarningKind.literals
