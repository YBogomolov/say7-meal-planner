import { Schema } from "effect"
import { IsoTimestamp, RecipeId } from "./recipe.ts"

/** Version of the stored file format `data/enriched/<id>.json`. */
export const ENRICHMENT_VERSION = 1

/** The models that the enrichment supports (spec A6). */
export const MODEL_NAMES = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const
export const ModelName = Schema.Literals(MODEL_NAMES)
export type ModelName = typeof ModelName.Type

/** The model of a run without `--model` (spec A6). */
export const DEFAULT_MODEL: ModelName = "claude-haiku-5-5"

/** The `thinking` parameter of a request. Both values are typed by the SDK (`ThinkingConfigDisabled`, `ThinkingConfigBetweenTools`). */
export type ThinkingSetting = { readonly type: "disabled" } | { readonly type: "between_tools" }

/**
 * The lowest thinking level of each model. Both models think by default, and the task needs no thinking.
 * Haiku 5.5 accepts `disabled`. Sonnet 5.5 rejects `disabled` with HTTP 400, and its lowest setting is `between_tools`.
 * The requests send no `effort`, so the model default stays (below `high`, where both settings are accepted).
 * Add the setting here when you add a model to `MODEL_NAMES`.
 */
export const THINKING_BY_MODEL: Readonly<Record<ModelName, ThinkingSetting>> = {
  "claude-haiku-5-5": { type: "disabled" },
  "claude-sonnet-5-5": { type: "between_tools" },
}

export const DishType = Schema.Literals([
  "soup",
  "main",
  "side",
  "salad",
  "snack",
  "savory_bake",
  "pancakes",
  "sauce",
  "other",
])
export type DishType = typeof DishType.Type

/** Can the dish be a lunch or a dinner alone? */
export const MealFit = Schema.Literals(["full_meal", "needs_side", "side_only", "not_a_meal"])
export type MealFit = typeof MealFit.Type

/** Protein family by animal. Offal and mince belong to their animal. */
export const ProteinFamily = Schema.Literals([
  "chicken",
  "turkey",
  "duck",
  "pork",
  "beef",
  "lamb",
  "rabbit",
  "fish",
  "seafood",
])
export type ProteinFamily = typeof ProteinFamily.Type

export const IngredientCategory = Schema.Literals([
  "poultry",
  "meat",
  "fish",
  "seafood",
  "dairy",
  "eggs",
  "vegetable",
  "fruit",
  "herb",
  "grain",
  "pasta",
  "legume",
  "bakery",
  "canned",
  "frozen",
  "sauce",
  "spice",
  "oil",
  "sweet",
  "nuts",
  "other",
])
export type IngredientCategory = typeof IngredientCategory.Type

export const IngredientUnit = Schema.Literals([
  "g",
  "ml",
  "pcs",
  "tbsp",
  "tsp",
  "pinch",
  "bunch",
  "clove",
  "slice",
  "pack",
])
export type IngredientUnit = typeof IngredientUnit.Type

/** `special` is equipment that the household of spec H7 does not have. */
export const Equipment = Schema.Literals([
  "hob",
  "oven",
  "microwave",
  "air_fryer",
  "food_processor",
  "blender",
  "immersion_blender",
  "mixer",
  "grill",
  "slow_cooker",
  "deep_fryer",
  "special",
])
export type Equipment = typeof Equipment.Type

/** Quality of the dish on day 2 and day 3. */
export const Reheats = Schema.Literals(["well", "ok", "poor", "served_cold"])
export type Reheats = typeof Reheats.Type

export const ServingsSource = Schema.Literals(["page", "estimated"])
export type ServingsSource = typeof ServingsSource.Type

/** Highest value of `fridgeDays`: the household keeps cooked food in the fridge for 4 days or less (spec H8). */
export const MAX_FRIDGE_DAYS = 4

const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const NonNegativeNumber = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/** One product of one ingredient line. A line with 2 products gives 2 items with the same `line`. */
export const IngredientItem = Schema.Struct({
  /** Index of the raw line, counted over all groups from 0. */
  line: NonNegativeInt,
  /** The product to buy: Russian, nominative, lower case, without quantity and preparation. */
  item: Schema.NonEmptyString,
  /** Variant or note, for example `"15–20%"`. */
  detail: Schema.NullOr(Schema.NonEmptyString),
  category: IngredientCategory,
  /** A staple that the household has: salt, pepper, sugar, flour, oil, vinegar, dry spices, baking powder, soda, water. */
  pantry: Schema.Boolean,
  /** As written. A range gives the upper value. */
  quantity: Schema.NullOr(NonNegativeNumber),
  unit: Schema.NullOr(IngredientUnit),
  /** Estimated mass in g (or volume in ml) for the shopping list. */
  grams: Schema.NullOr(NonNegativeNumber),
  optional: Schema.Boolean,
})
export type IngredientItem = typeof IngredientItem.Type

const minNotAboveMax = Schema.makeFilter<{
  readonly min: number
  readonly max: number
}>((range) => range.min <= range.max || "Expected min to be less than or equal to max")

export const EnrichedServings = Schema.Struct({
  min: PositiveInt,
  max: PositiveInt,
  source: ServingsSource,
}).pipe(Schema.check(minNotAboveMax))
export type EnrichedServings = typeof EnrichedServings.Type

/**
 * The result of the model for one recipe (spec P3.4, table "LLM result").
 *
 * The ranges are checked here, not in the JSON Schema of the API (spec A4).
 * Two more checks need the input: every `ingredients[].line` must be a line of the recipe (`checkLineRange`),
 * and every line of the recipe must have at least 1 item (`checkLineCoverage`). The caller runs them after the decode.
 */
export const Enrichment = Schema.Struct({
  dishType: DishType,
  mealFit: MealFit,
  /** A side dish that the author mentions, or `null`. */
  sideHint: Schema.NullOr(Schema.NonEmptyString),
  proteinFamilies: Schema.Array(ProteinFamily),
  /** No meat, fish or seafood. */
  vegetarian: Schema.Boolean,
  ingredients: Schema.Array(IngredientItem),
  servings: EnrichedServings,
  /** Hands-on time in minutes. */
  activeMinutes: NonNegativeInt,
  /** Minutes from the start to the table, without the long wait of `longWaitHours`. */
  totalMinutes: NonNegativeInt,
  /** Hours of marinating, resting or chilling, or `null`. */
  longWaitHours: Schema.NullOr(NonNegativeNumber),
  /** 0 none, 1 mild, 2 noticeable, 3 hot. */
  heat: Schema.Literals([0, 1, 2, 3]),
  /** 1 simple, 3 complex. */
  difficulty: Schema.Literals([1, 2, 3]),
  equipment: Schema.Array(Equipment),
  /** Days that the cooked dish keeps in the fridge. */
  fridgeDays: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: MAX_FRIDGE_DAYS }))),
  freezable: Schema.Boolean,
  reheats: Reheats,
})
export type Enrichment = typeof Enrichment.Type

/** JSON text codec for the answer of the model. */
export const EnrichmentJson = Schema.fromJsonString(Enrichment)

/**
 * The lines of `ingredients` that point outside the recipe, as messages for the model.
 * The recipe has the lines 0 to `lineCount - 1`. The result is empty when all lines are valid.
 */
export const checkLineRange = (enrichment: Enrichment, lineCount: number): ReadonlyArray<string> =>
  enrichment.ingredients.flatMap((item, position) =>
    item.line < lineCount
      ? []
      : [`ingredients[${position}].line is ${item.line}, but the recipe has the lines 0 to ${lineCount - 1}`]
  )

/**
 * The lines of the recipe that have no item, as a message for the model (spec P3.4: one item per raw line).
 * The recipe has the lines 0 to `lineCount - 1`. The result is empty when every line has at least 1 item.
 */
export const checkLineCoverage = (enrichment: Enrichment, lineCount: number): ReadonlyArray<string> => {
  const covered = new Set(enrichment.ingredients.map((item) => item.line))
  const missing = Array.from({ length: lineCount }, (_, line) => line).filter((line) => !covered.has(line))
  return missing.length === 0
    ? []
    : [`ingredients has no item for the lines ${missing.join(", ")}; every line of the recipe needs at least 1 item`]
}

/** Tokens that the API bills. `input` does not include the cache tokens. */
export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  cacheReadTokens: Schema.Natural,
  cacheCreationTokens: Schema.Natural,
})
export type TokenUsage = typeof TokenUsage.Type

export const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
})

export const Sha256Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)))

/**
 * Stored in `data/enriched/<id>.json` (spec P3.4).
 *
 * - `inputHash` is the SHA-256 of the canonical input, `promptVersion` and `model` (spec A8).
 * - `usage` is the sum of all attempts for this recipe, a failed first attempt included.
 *   The field `cacheCreationTokens` is an addition to the spec: the API bills these tokens at a higher price.
 */
export const EnrichedRecipe = Schema.Struct({
  id: RecipeId,
  enrichmentVersion: Schema.Literal(ENRICHMENT_VERSION),
  model: ModelName,
  promptVersion: PositiveInt,
  inputHash: Sha256Hex,
  createdAt: IsoTimestamp,
  usage: TokenUsage,
  enrichment: Enrichment,
})
export type EnrichedRecipe = typeof EnrichedRecipe.Type

/** JSON text codec for `data/enriched/<id>.json`. */
export const EnrichedRecipeJson = Schema.fromJsonString(EnrichedRecipe, {
  space: 2,
})
