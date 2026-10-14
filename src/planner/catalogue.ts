import { Effect, FileSystem, Option, Path, Result, Schema } from "effect"
import type { Aliases, Catalogue, CatalogueEntry, ProteinTable } from "../domain/catalogue.ts"
import { EnrichedRecipeJson } from "../domain/enriched-recipe.ts"
import type { EnrichedRecipe } from "../domain/enriched-recipe.ts"
import { ParsedRecipeJson } from "../domain/parsed-recipe.ts"
import type { ParsedRecipe } from "../domain/parsed-recipe.ts"
import { RecipeId } from "../domain/recipe.ts"
import { ParsedReadError } from "../enrich/store.ts"
import { StoreError } from "../scraper/store.ts"
import { NO_ALIASES, normaliseItem } from "./items.ts"
import { NO_PROTEIN } from "./protein.ts"
import { applyServingsOverrides, NO_SERVINGS_OVERRIDES } from "./servings.ts"
import type { ServingsOverrides } from "./servings.ts"

const RECIPE_FILE = /^([1-9]\d*)\.json$/
const READ_CONCURRENCY = 16

/**
 * The catalogue entry of a recipe: the facts of the page and the enrichment, with normalised item names (spec P4.2.2).
 * Pure. The intro and the steps are left out.
 */
export const toCatalogueEntry = (parsed: ParsedRecipe, enriched: EnrichedRecipe, aliases: Aliases): CatalogueEntry => {
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
      ingredients: ingredients.map(({ item, ...rest }) => ({ ...rest, item: normaliseItem(item, aliases), rawItem: item }))
    }
  }
}

/** The catalogue of the given entries, sorted by ID. */
export const makeCatalogue = (
  entries: ReadonlyArray<CatalogueEntry>,
  aliases: Aliases = NO_ALIASES,
  overridden: ReadonlySet<RecipeId> = new Set(),
  proteinTable: ProteinTable = NO_PROTEIN
): Catalogue => {
  const sorted = [...entries].sort((a, b) => a.id - b.id)
  return { entries: sorted, byId: new Map(sorted.map((entry) => [entry.id, entry])), aliases, overridden, proteinTable }
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

export interface LoadedCatalogue {
  readonly catalogue: Catalogue
  readonly skipped: ReadonlyArray<SkippedRecipe>
  /** IDs in the servings overrides that are not in the catalogue (a warning, not a failure). Sorted. */
  readonly unknownOverrides: ReadonlyArray<RecipeId>
}

const io = <A>(target: string, effect: Effect.Effect<A, { readonly message: string }>) =>
  effect.pipe(Effect.mapError((error) => new StoreError({ path: target, message: error.message })))

/** The recipe IDs of the files `<dir>/<id>.json`. The directory must exist. */
const listRecipeIds = (dir: string, hint: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* io(dir, fs.exists(dir)))) {
      return yield* new StoreError({ path: dir, message: `Каталог ${dir} не найден. ${hint}` })
    }
    const names = yield* io(dir, fs.readDirectory(dir))
    return names.flatMap((name) => {
      const digits = RECIPE_FILE.exec(name)?.[1]
      return digits === undefined ? [] : Option.toArray(Schema.decodeUnknownOption(RecipeId)(Number(digits)))
    })
  })

/** Read and decode a recipe file. The failure is the Russian text for the list of skipped recipes. */
const readRecipeFile = <A, I>(target: string, id: RecipeId, codec: Schema.Codec<A, I>, idOf: (value: A) => RecipeId) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(target).pipe(
      Effect.mapError((error) => `Файл ${target} не читается: ${error.message}`)
    )
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
 * The other recipes are in `skipped`, with the reason. The recipes without an enriched file (desserts, for example) are there too.
 * The load fails only if one of the two directories does not exist, or cannot be listed.
 * The item names are normalised with `aliases`.
 * `overrides` set `servings.min` and `servings.max` after the decode (see `applyServingsOverrides`).
 * `proteinTable` goes into the catalogue as it is (spec P7.1).
 */
export const loadCatalogue = (
  dataDir: string,
  aliases: Aliases = NO_ALIASES,
  overrides: ServingsOverrides = NO_SERVINGS_OVERRIDES,
  proteinTable: ProteinTable = NO_PROTEIN
): Effect.Effect<LoadedCatalogue, StoreError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const parsedDir = path.join(dataDir, "parsed")
    const enrichedDir = path.join(dataDir, "enriched")
    const parsedIds = new Set(yield* listRecipeIds(parsedDir, "Запустите `npm run parse`."))
    const enrichedIds = new Set(yield* listRecipeIds(enrichedDir, "Запустите `npm run enrich`."))
    const ids = [...new Set([...parsedIds, ...enrichedIds])].sort((a, b) => a - b)

    const load = (id: RecipeId) =>
      Effect.gen(function*() {
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
        const enriched = yield* Effect.result(readRecipeFile(enrichedPath, id, EnrichedRecipeJson, (recipe) => recipe.id))
        if (Result.isFailure(enriched)) {
          return skip("invalid_enriched", enriched.failure)
        }
        return enriched.success.enrichment.mealFit === "not_a_meal"
          ? skip("not_a_meal", "Блюдо не годится для обеда или ужина (mealFit: not_a_meal).")
          : Result.succeed(toCatalogueEntry(parsed.success, enriched.success, aliases))
      })

    const results = yield* Effect.forEach(ids, load, { concurrency: READ_CONCURRENCY })
    const applied = applyServingsOverrides(
      results.flatMap((result) => Result.isSuccess(result) ? [result.success] : []),
      overrides
    )
    return {
      catalogue: makeCatalogue(applied.entries, aliases, applied.overridden, proteinTable),
      skipped: results.flatMap((result) => Result.isFailure(result) ? [result.failure] : []),
      unknownOverrides: applied.unknown
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
  Effect.gen(function*() {
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
      servingsText: parsed.servingsText
    }
  }).pipe(Effect.mapError((error) => new ParsedReadError({ id, message: error.message })))
