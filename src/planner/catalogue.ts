import { Effect, FileSystem, Option, Path, Result, Schema } from "effect"
import type { Aliases, Catalogue, CatalogueEntry, ProteinTable } from "../domain/catalogue.ts"
import type { SimpleBreakfast } from "../domain/simple-breakfast.ts"
import { EnrichedRecipeJson } from "../domain/enriched-recipe.ts"
import type { EnrichedRecipe } from "../domain/enriched-recipe.ts"
import { ParsedRecipeJson } from "../domain/parsed-recipe.ts"
import type { ParsedRecipe } from "../domain/parsed-recipe.ts"
import { RecipeId } from "../domain/recipe.ts"
import { ParsedReadError } from "../enrich/store.ts"
import { io, StoreError } from "../store/fs.ts"
import { isBreakfastEligible } from "./breakfast.ts"
import { NO_ALIASES, normaliseItem } from "./items.ts"
import { PlannerPaths } from "./paths.ts"
import { NO_PROTEIN } from "./protein.ts"
import { NO_SIMPLE_BREAKFASTS } from "./simple.ts"
import { applyServingsOverrides, NO_SERVINGS_OVERRIDES } from "./servings.ts"
import type { ServingsOverrides } from "./servings.ts"

const RECIPE_FILE = /^([1-9]\d*)\.json$/
const READ_CONCURRENCY = 16

/**
 * The catalogue entry of a recipe: the facts of the page and the enrichment, with normalised item names (spec P4.2.2).
 * Pure. The intro and the steps are left out.
 * `breakfastExtraIds` are the recipes that `household.breakfastExtraIds` adds to the breakfast candidates (spec P7.2.4).
 * `lightDinnerIds` are the light dinners (spec P7.4.1): they are also breakfast candidates.
 */
export const toCatalogueEntry = (
  parsed: ParsedRecipe,
  enriched: EnrichedRecipe,
  aliases: Aliases,
  breakfastExtraIds: ReadonlySet<RecipeId> = new Set(),
  lightDinnerIds: ReadonlySet<RecipeId> = new Set()
): CatalogueEntry => {
  const { ingredients, ...enrichment } = enriched.enrichment
  const category = parsed.categories[0]
  return {
    id: parsed.id,
    url: parsed.url,
    title: parsed.title,
    primaryCategory: category === undefined ? null : { id: category.id, name: category.name },
    commentsCount: parsed.commentsCount,
    enrichment: {
      ...enrichment,
      ingredients: ingredients.map(({ item, ...rest }) => ({
        ...rest,
        item: normaliseItem(item, aliases),
        rawItem: item,
      })),
    },
    breakfastEligible: isBreakfastEligible(parsed, breakfastExtraIds, lightDinnerIds),
    lightDinner: lightDinnerIds.has(parsed.id),
  }
}

/** The catalogue of the given entries, sorted by ID. */
export const makeCatalogue = (
  entries: ReadonlyArray<CatalogueEntry>,
  aliases: Aliases = NO_ALIASES,
  overridden: ReadonlySet<RecipeId> = new Set(),
  proteinTable: ProteinTable = NO_PROTEIN,
  simpleBreakfasts: ReadonlyArray<SimpleBreakfast> = NO_SIMPLE_BREAKFASTS
): Catalogue => {
  const sorted = [...entries].sort((a, b) => a.id - b.id)
  return {
    entries: sorted,
    byId: new Map(sorted.map((entry) => [entry.id, entry])),
    aliases,
    overridden,
    proteinTable,
    simpleBreakfasts,
    simpleById: new Map(simpleBreakfasts.map((simple) => [simple.id, simple])),
  }
}

/** Why `loadCatalogue` leaves a recipe out. */
export const SKIP_REASONS = ["no_parsed", "no_enriched", "invalid_parsed", "invalid_enriched", "not_a_meal"] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

export interface SkippedRecipe {
  readonly id: RecipeId
  readonly reason: SkipReason
  /** Russian text that tells what is wrong. */
  readonly message: string
}

/** What `loadCatalogue` takes from the config besides the aliases, the servings overrides and the protein table. */
export interface CatalogueExtras {
  /** `config/simple-breakfasts.json`, loaded (spec P7.2.3). */
  readonly simpleBreakfasts?: ReadonlyArray<SimpleBreakfast>
  /** `household.breakfastExtraIds` (spec P7.2.4). */
  readonly breakfastExtraIds?: ReadonlyArray<RecipeId>
  /** `household.lightDinnerIds` (spec P7.4.1). */
  readonly lightDinnerIds?: ReadonlyArray<RecipeId>
}

/** The config that `loadCatalogue` takes (what `loadPlannerConfig` returns). Every part is optional: the default is empty. */
export interface CatalogueConfig {
  readonly aliases?: Aliases
  readonly overrides?: ServingsOverrides
  readonly proteinTable?: ProteinTable
  readonly extras?: CatalogueExtras
}

export interface LoadedCatalogue {
  readonly catalogue: Catalogue
  readonly skipped: ReadonlyArray<SkippedRecipe>
  /** IDs in the servings overrides that are not in the catalogue (a warning, not a failure). Sorted. */
  readonly unknownOverrides: ReadonlyArray<RecipeId>
}

/** The recipe IDs of the files `<dir>/<id>.json`. The directory must exist. */
const listRecipeIds = (dir: string, hint: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* io(dir, fs.exists(dir)))) {
      return yield* new StoreError({
        path: dir,
        message: `Каталог ${dir} не найден. ${hint}`,
      })
    }
    const names = yield* io(dir, fs.readDirectory(dir))
    return names.flatMap((name) => {
      const digits = RECIPE_FILE.exec(name)?.[1]
      return digits === undefined ? [] : Option.toArray(Schema.decodeUnknownOption(RecipeId)(Number(digits)))
    })
  })

/** Read and decode a recipe file. The failure is the Russian text for the list of skipped recipes. */
const readRecipeFile = <A, I>(target: string, id: RecipeId, codec: Schema.Codec<A, I>, idOf: (value: A) => RecipeId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(target)
      .pipe(Effect.mapError((error) => `Файл ${target} не читается: ${error.message}`))
    const value = yield* Schema.decodeUnknownEffect(codec)(text).pipe(
      Effect.mapError((error) => `Файл ${target} не прошёл проверку: ${error.message}`)
    )
    return idOf(value) === id
      ? value
      : yield* Effect.fail(`Файл ${target} содержит рецепт ${idOf(value)}, а имя файла говорит о рецепте ${id}`)
  })

/**
 * Load the catalogue from `<dataDir>/parsed/<id>.json` and `<dataDir>/enriched/<id>.json` (spec P4.2.1).
 *
 * A recipe is in the catalogue if both files decode and `mealFit` is not `not_a_meal`.
 * A `not_a_meal` recipe stays in the catalogue if it is a breakfast candidate (spec P7.2.4, `breakfastEligible`)
 * or a light dinner (spec P7.4.1, `lightDinner`): it is valid only in breakfast slots, and light dinners also in dinner slots.
 * The other recipes are in `skipped`, with the reason. The recipes without an enriched file (desserts, for example) are there too.
 * The load fails only if one of the two directories does not exist, or cannot be listed.
 * The item names are normalised with `config.aliases`.
 * `config.overrides` set `servings.min` and `servings.max` after the decode (see `applyServingsOverrides`).
 * `config.proteinTable` goes into the catalogue as it is (spec P7.1). So do the simple breakfasts of `config.extras` (spec P7.2.3).
 */
export const loadCatalogue = (
  config: CatalogueConfig = {}
): Effect.Effect<LoadedCatalogue, StoreError, FileSystem.FileSystem | Path.Path | PlannerPaths> =>
  Effect.gen(function* () {
    const { aliases = NO_ALIASES, overrides = NO_SERVINGS_OVERRIDES, proteinTable = NO_PROTEIN, extras = {} } = config
    const path = yield* Path.Path
    const { dataDir } = yield* PlannerPaths
    const parsedDir = path.join(dataDir, "parsed")
    const enrichedDir = path.join(dataDir, "enriched")
    const parsedIds = new Set(yield* listRecipeIds(parsedDir, "Запустите `npm run parse`."))
    const enrichedIds = new Set(yield* listRecipeIds(enrichedDir, "Запустите `npm run enrich`."))
    const ids = [...new Set([...parsedIds, ...enrichedIds])].sort((a, b) => a - b)
    const extraIds = new Set(extras.breakfastExtraIds ?? [])
    const lightDinnerIds = new Set(extras.lightDinnerIds ?? [])

    const load = (id: RecipeId) =>
      Effect.gen(function* () {
        const parsedPath = path.join(parsedDir, `${id}.json`)
        const enrichedPath = path.join(enrichedDir, `${id}.json`)
        const skip = (reason: SkipReason, message: string): Result.Result<CatalogueEntry, SkippedRecipe> =>
          Result.fail({ id, reason, message })
        if (!parsedIds.has(id)) {
          return skip("no_parsed", `Нет файла ${parsedPath}.`)
        }
        if (!enrichedIds.has(id)) {
          return skip("no_enriched", `Нет файла ${enrichedPath}.`)
        }
        const parsed = yield* Effect.result(readRecipeFile(parsedPath, id, ParsedRecipeJson, (recipe) => recipe.id))
        if (Result.isFailure(parsed)) {
          return skip("invalid_parsed", parsed.failure)
        }
        const enriched = yield* Effect.result(
          readRecipeFile(enrichedPath, id, EnrichedRecipeJson, (recipe) => recipe.id)
        )
        if (Result.isFailure(enriched)) {
          return skip("invalid_enriched", enriched.failure)
        }
        const entry = toCatalogueEntry(parsed.success, enriched.success, aliases, extraIds, lightDinnerIds)
        return enriched.success.enrichment.mealFit === "not_a_meal" && !entry.breakfastEligible && !entry.lightDinner
          ? skip("not_a_meal", "Блюдо не годится для обеда, ужина и завтрака (mealFit: not_a_meal).")
          : Result.succeed(entry)
      })

    const results = yield* Effect.forEach(ids, load, {
      concurrency: READ_CONCURRENCY,
    })
    const applied = applyServingsOverrides(
      results.flatMap((result) => (Result.isSuccess(result) ? [result.success] : [])),
      overrides
    )
    return {
      catalogue: makeCatalogue(applied.entries, aliases, applied.overridden, proteinTable, extras.simpleBreakfasts),
      skipped: results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : [])),
      unknownOverrides: applied.unknown,
    }
  })

/** The text parts of a recipe that the catalogue does not keep. For the tool `get_recipe`. */
export type RecipeDetails = Pick<
  ParsedRecipe,
  "id" | "url" | "title" | "intro" | "ingredientGroups" | "steps" | "yieldText" | "servingsText"
>

/** Read the intro, the ingredient lines and the steps of one recipe from `<dataDir>/parsed/<id>.json` (spec P4.2.2). */
export const getRecipeDetails = (
  dataDir: string,
  id: RecipeId
): Effect.Effect<RecipeDetails, ParsedReadError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = path.join(dataDir, "parsed", `${id}.json`)
    const text = yield* fs.readFileString(target)
    const parsed = yield* Schema.decodeUnknownEffect(ParsedRecipeJson)(text)
    return {
      id: parsed.id,
      url: parsed.url,
      title: parsed.title,
      intro: parsed.intro,
      ingredientGroups: parsed.ingredientGroups,
      steps: parsed.steps,
      yieldText: parsed.yieldText,
      servingsText: parsed.servingsText,
    }
  }).pipe(Effect.mapError((error) => new ParsedReadError({ id, message: error.message })))
