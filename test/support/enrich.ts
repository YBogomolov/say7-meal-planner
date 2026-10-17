import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { assert } from "@effect/vitest"
import { Console, Effect, FileSystem, Layer, Option, Result, Schema } from "effect"
import type { Enrichment } from "../../src/domain/enriched-recipe.ts"
import { ParsedRecipe, ParsedRecipeJson } from "../../src/domain/parsed-recipe.ts"
import { RecipeId } from "../../src/domain/recipe.ts"
import { enrichStoreLayer } from "../../src/enrich/layers.ts"
import type { EnrichOptions } from "../../src/enrich/run.ts"

export const id = (n: number): RecipeId => Result.getOrThrow(Schema.decodeUnknownResult(RecipeId)(n))

/** The value, or a test failure with a clear text when the value is absent. */
export const must = <A>(value: A | undefined, what: string): A =>
  value === undefined ? assert.fail(`${what} is missing`) : value

export const SALADS = { id: 38, slug: "Salatyi", name: "Салаты" } as const
export const DESSERTS = { id: 39, slug: "Deserty", name: "Десерты" } as const
export const SOUPS = {
  id: 47,
  slug: "Pervyie-bljuda",
  name: "Первые блюда",
} as const

export interface ParsedOptions {
  readonly categories?: ReadonlyArray<{
    readonly id: number
    readonly slug: string
    readonly name: string
  }>
  /** Ingredient lines. They are all in one group. */
  readonly lines?: ReadonlyArray<string>
  readonly title?: string
}

/** A valid parsed recipe with invented text. */
export const parsedRecipe = (n: number, options: ParsedOptions = {}): ParsedRecipe =>
  Schema.decodeUnknownSync(ParsedRecipe)({
    parserVersion: 1,
    id: n,
    url: `https://www.say7.info/cook/recipe/${n}-Test.html`,
    title: options.title ?? `Тестовое блюдо ${n}`,
    intro: ["Простое блюдо для теста."],
    categories: options.categories ?? [SOUPS],
    ingredientGroups: [{ title: null, items: options.lines ?? ["200 г моркови", "соль"] }],
    steps: ["Нарезать.", "Варить 20 минут."],
    yieldText: "4 порции",
    servingsText: "4 порции",
    servings: { min: 4, max: 4 },
    durations: [],
    longWait: false,
    addedAt: "2024-01-02",
    commentsCount: 3,
    similarIds: [],
    sourceSha256: "b".repeat(64),
  })

/** A valid `Enrichment` with 1 item for each of the lines `0` to `lines - 1`. */
export const enrichmentFor = (lines: number, overrides: Partial<Enrichment> = {}): Enrichment => ({
  ingredients: Array.from({ length: lines }, (_, line) => ({
    line,
    item: `продукт ${line}`,
    detail: null,
    category: "other" as const,
    pantry: false,
    quantity: 100,
    unit: "g" as const,
    grams: 100,
    optional: false,
  })),
  proteinFamilies: [],
  vegetarian: true,
  dishType: "soup",
  mealFit: "full_meal",
  sideHint: null,
  servings: { min: 4, max: 4, source: "page" },
  activeMinutes: 20,
  totalMinutes: 40,
  longWaitHours: null,
  heat: 0,
  difficulty: 1,
  equipment: ["hob"],
  fridgeDays: 3,
  freezable: true,
  reheats: "well",
  ...overrides,
})

export interface Dirs {
  readonly dataDir: string
  readonly outDir: string
}

export interface Captured {
  readonly lines: Array<string>
  readonly warnings: Array<string>
  readonly errors: Array<string>
}

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/**
 * A temporary data directory with `parsed/<id>.json` for the given recipes, and an empty output directory.
 * The directory is removed at the end. `use` gets the paths and the captured console output.
 */
export const withEnrichDirs = <A, E, R>(
  recipes: ReadonlyArray<ParsedRecipe>,
  use: (
    context: Dirs & {
      readonly captured: Captured
      readonly store: ReturnType<typeof enrichStoreLayer>
    }
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "say7-enrich-" })
    const dataDir = `${root}/data`
    const outDir = `${dataDir}/enriched`
    yield* fs.makeDirectory(`${dataDir}/parsed`, { recursive: true })
    for (const recipe of recipes) {
      yield* fs.writeFileString(`${dataDir}/parsed/${recipe.id}.json`, Schema.encodeSync(ParsedRecipeJson)(recipe))
    }
    const captured: Captured = { lines: [], warnings: [], errors: [] }
    return yield* use({
      dataDir,
      outDir,
      captured,
      store: enrichStoreLayer({ dataDir, outDir }),
    }).pipe(
      Effect.provideService(Console.Console, {
        ...globalThis.console,
        log: (...parts: ReadonlyArray<unknown>) => void captured.lines.push(parts.join(" ")),
        warn: (...parts: ReadonlyArray<unknown>) => void captured.warnings.push(parts.join(" ")),
        error: (...parts: ReadonlyArray<unknown>) => void captured.errors.push(parts.join(" ")),
      })
    )
  }).pipe(Effect.provide(platform))

export const readJson = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return JSON.parse(yield* fs.readFileString(path))
  })

/** The options of a run, with test defaults: all recipes, no limit, no flags. */
export const runOptions = (overrides: Partial<EnrichOptions> = {}): EnrichOptions => ({
  model: "claude-haiku-5-5",
  ids: Option.none(),
  limit: Option.none(),
  sync: false,
  retryFailed: false,
  ...overrides,
})

/** The recipe IDs of a list of numbers, as the `ids` option. */
export const idSet = (...numbers: ReadonlyArray<number>): Option.Option<ReadonlySet<RecipeId>> =>
  Option.some(new Set(numbers.map(id)))
