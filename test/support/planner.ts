import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import type { Aliases, Catalogue, CatalogueEntry, ProteinTable } from "../../src/domain/catalogue.ts"
import { EnrichedRecipeJson, NO_USAGE } from "../../src/domain/enriched-recipe.ts"
import type { EnrichedRecipe, Enrichment, IngredientItem } from "../../src/domain/enriched-recipe.ts"
import type { MealName } from "../../src/domain/household.ts"
import { ParsedRecipeJson } from "../../src/domain/parsed-recipe.ts"
import type { SimpleBreakfast } from "../../src/domain/simple-breakfast.ts"
import { WeekPlan } from "../../src/domain/week-plan.ts"
import type { CookingSession, PlanScale } from "../../src/domain/week-plan.ts"
import { PlannerPaths } from "../../src/planner/paths.ts"
import { makeCatalogue, toCatalogueEntry } from "../../src/planner/catalogue.ts"
import { NO_ALIASES } from "../../src/planner/items.ts"
import { NO_PROTEIN } from "../../src/planner/protein.ts"
import { enrichmentFor, id, parsedRecipe } from "./enrich.ts"
import type { ParsedOptions } from "./enrich.ts"

/** Synthetic recipes for the planner tests. The titles and the items are invented. */

/** An ingredient line without the `line` index: the helper numbers the lines. */
export type IngredientSpec = Omit<IngredientItem, "line">

/** An ingredient with defaults: not pantry, not optional, no quantity, category `other`. */
export const ing = (item: string, overrides: Partial<Omit<IngredientSpec, "item">> = {}): IngredientSpec => ({
  item,
  detail: null,
  category: "other",
  pantry: false,
  quantity: null,
  unit: null,
  grams: null,
  optional: false,
  ...overrides,
})

/** A quantity in grams: `quantity`, `unit: "g"` and `grams` are the same number. */
export const inGrams = (
  item: string,
  amount: number,
  overrides: Partial<Omit<IngredientSpec, "item">> = {}
): IngredientSpec => ing(item, { quantity: amount, unit: "g", grams: amount, ...overrides })

/** Changes of the enrichment of a test dish. */
export type EnrichmentChange = Partial<Omit<Enrichment, "ingredients">>

export interface DishOptions {
  readonly title?: string
  readonly ingredients?: ReadonlyArray<IngredientSpec>
  readonly enrichment?: EnrichmentChange
  readonly commentsCount?: number | null
  /** The categories of the page. The default is soups (`SOUPS` of the enrich support). */
  readonly categories?: ParsedOptions["categories"]
  /** True if the ID is in `household.lightDinnerIds` (spec P7.4.1). */
  readonly lightDinner?: boolean
}

/** The enriched recipe of a file `data/enriched/<n>.json`, with test defaults. */
export const enrichedRecipe = (
  n: number,
  options: Pick<DishOptions, "ingredients" | "enrichment"> = {}
): EnrichedRecipe => {
  const specs = options.ingredients ?? [inGrams("продукт", 100)]
  const base = enrichmentFor(specs.length, options.enrichment)
  return {
    id: id(n),
    enrichmentVersion: 1,
    model: "claude-haiku-5-5",
    promptVersion: 1,
    inputHash: "a".repeat(64),
    createdAt: "2026-10-12T00:00:00.000Z",
    usage: NO_USAGE,
    enrichment: {
      ...base,
      ingredients: specs.map((spec, line) => ({ ...spec, line })),
    },
  }
}

/** A catalogue entry, built the way `loadCatalogue` builds it. */
export const entryOf = (n: number, options: DishOptions & { readonly aliases?: Aliases } = {}): CatalogueEntry =>
  toCatalogueEntry(
    {
      ...parsedRecipe(n, {
        title: options.title ?? `Тестовое блюдо ${n}`,
        ...(options.categories === undefined ? {} : { categories: options.categories }),
      }),
      commentsCount: options.commentsCount === undefined ? 3 : options.commentsCount,
    },
    enrichedRecipe(n, options),
    options.aliases ?? NO_ALIASES,
    new Set(),
    options.lightDinner === true ? new Set([id(n)]) : new Set()
  )

export const catalogueOf = (
  entries: ReadonlyArray<CatalogueEntry>,
  aliases: Aliases = NO_ALIASES,
  proteinTable: ProteinTable = NO_PROTEIN,
  simpleBreakfasts: ReadonlyArray<SimpleBreakfast> = []
): Catalogue => makeCatalogue(entries, aliases, undefined, proteinTable, simpleBreakfasts)

/** The category 50 of the site: a breakfast candidate (spec P7.2.4). */
export const PANCAKES = {
  id: 50,
  slug: "blini",
  name: "Блины, оладьи, сырники",
} as const

export interface PlanSpec {
  readonly weekStart?: string
  readonly cooking: ReadonlyArray<{
    readonly session: CookingSession
    readonly recipeId: number
    readonly scale?: PlanScale
  }>
  readonly meals: ReadonlyArray<{
    readonly day: number
    readonly meal: MealName
    readonly recipeIds: ReadonlyArray<number>
    readonly simpleIds?: ReadonlyArray<string>
  }>
  readonly notes?: string | null
}

/** A plan that went through the decoder (scale 1 and the week of 2026-10-17 are the defaults). */
export const planOf = (spec: PlanSpec): WeekPlan =>
  Schema.decodeUnknownSync(WeekPlan)({
    weekStart: spec.weekStart ?? "2026-10-17",
    cooking: spec.cooking.map((entry) => ({
      session: entry.session,
      recipeId: entry.recipeId,
      scale: entry.scale ?? 1,
    })),
    meals: spec.meals,
    notes: spec.notes ?? null,
  })

/**
 * The base week: 7 dishes, each cooked once and eaten in 2 slots on 2 different days (6 portions of 6 to 8).
 * Session A (day 0) cooks the dishes 1 to 4, session B (day 4) the dishes 5 to 7.
 * The week has no error and no warning. A test changes 1 thing and looks for the code that this change causes.
 */
export const BASE_COOKING: PlanSpec["cooking"] = [
  { session: "A", recipeId: 1 },
  { session: "A", recipeId: 2 },
  { session: "A", recipeId: 3 },
  { session: "A", recipeId: 4 },
  { session: "B", recipeId: 5 },
  { session: "B", recipeId: 6 },
  { session: "B", recipeId: 7 },
]

export const BASE_MEALS: PlanSpec["meals"] = [
  { day: 0, meal: "lunch", recipeIds: [1] },
  { day: 0, meal: "dinner", recipeIds: [2] },
  { day: 1, meal: "lunch", recipeIds: [1] },
  { day: 1, meal: "dinner", recipeIds: [2] },
  { day: 2, meal: "lunch", recipeIds: [3] },
  { day: 2, meal: "dinner", recipeIds: [4] },
  { day: 3, meal: "lunch", recipeIds: [3] },
  { day: 3, meal: "dinner", recipeIds: [4] },
  { day: 4, meal: "lunch", recipeIds: [5] },
  { day: 4, meal: "dinner", recipeIds: [7] },
  { day: 5, meal: "lunch", recipeIds: [6] },
  { day: 5, meal: "dinner", recipeIds: [5] },
  { day: 6, meal: "lunch", recipeIds: [7] },
  { day: 6, meal: "dinner", recipeIds: [6] },
]

export const basePlan = (): WeekPlan => planOf({ cooking: BASE_COOKING, meals: BASE_MEALS })

/** The dishes of the base week as options. A test replaces 1 dish with `baseCatalogue({ 3: { … } })`. */
const BASE_DISHES: Readonly<Record<number, DishOptions>> = {
  1: {
    title: "Суп Альфа",
    enrichment: {
      dishType: "soup",
      proteinFamilies: ["chicken"],
      vegetarian: false,
    },
    ingredients: [
      inGrams("куриное филе", 500, { category: "poultry" }),
      inGrams("картофель", 400, { category: "vegetable" }),
      ing("лук репчатый", {
        category: "vegetable",
        quantity: 2,
        unit: "pcs",
        grams: 200,
      }),
      ing("соль", { category: "spice", pantry: true }),
    ],
  },
  2: {
    title: "Рагу Браво",
    enrichment: {
      dishType: "main",
      proteinFamilies: ["chicken"],
      vegetarian: false,
    },
    ingredients: [
      inGrams("куриные бёдра", 800, { category: "poultry" }),
      ing("лук репчатый", {
        category: "vegetable",
        quantity: 1,
        unit: "pcs",
        grams: 100,
      }),
      ing("сметана", {
        category: "dairy",
        quantity: 2,
        unit: "tbsp",
        grams: 40,
      }),
      ing("перец чёрный", { category: "spice", pantry: true }),
    ],
  },
  3: {
    title: "Плов Чарли",
    enrichment: { dishType: "main", vegetarian: true },
    ingredients: [
      inGrams("рис", 300, { category: "grain" }),
      ing("морковь", { category: "vegetable", quantity: 3, unit: "pcs" }),
      ing("лук репчатый", {
        category: "vegetable",
        quantity: 1,
        unit: "pcs",
        grams: 100,
      }),
      ing("масло подсолнечное", {
        category: "oil",
        pantry: true,
        quantity: 3,
        unit: "tbsp",
        grams: 45,
      }),
    ],
  },
  4: {
    title: "Салат Дельта",
    enrichment: { dishType: "salad", vegetarian: true },
    ingredients: [
      ing("яйца", { category: "eggs", quantity: 4, unit: "pcs", grams: 200 }),
      ing("огурцы", {
        category: "vegetable",
        quantity: 3,
        unit: "pcs",
        grams: 300,
      }),
      ing("укроп", { category: "herb", quantity: 1, unit: "bunch", grams: 30 }),
      ing("сметана", {
        category: "dairy",
        quantity: 3,
        unit: "tbsp",
        grams: 60,
      }),
    ],
  },
  5: {
    title: "Запеканка Эхо",
    enrichment: { dishType: "main", vegetarian: true },
    ingredients: [
      inGrams("творог", 500, { category: "dairy" }),
      ing("яйца", { category: "eggs", quantity: 2, unit: "pcs", grams: 100 }),
      ing("мука", { category: "grain", pantry: true }),
      ing("ванилин", {
        category: "sweet",
        optional: true,
        quantity: 1,
        unit: "pinch",
      }),
    ],
  },
  6: {
    title: "Паста Фокстрот",
    enrichment: { dishType: "main", vegetarian: true },
    ingredients: [
      inGrams("макароны", 400, { category: "pasta" }),
      ing("томатная паста", {
        category: "sauce",
        quantity: 2,
        unit: "tbsp",
        grams: 40,
      }),
      inGrams("сыр", 100, { category: "dairy", optional: true }),
    ],
  },
  7: {
    title: "Жаркое Гольф",
    enrichment: {
      dishType: "main",
      proteinFamilies: ["chicken"],
      vegetarian: false,
    },
    ingredients: [
      inGrams("куриное филе", 400, { category: "poultry" }),
      inGrams("кабачки", 600, { category: "vegetable" }),
      inGrams("морковь", 200, { category: "vegetable" }),
      ing("укроп", {
        category: "herb",
        optional: true,
        quantity: 1,
        unit: "bunch",
      }),
    ],
  },
}

const BASE_ENRICHMENT: EnrichmentChange = {
  mealFit: "full_meal",
  servings: { min: 6, max: 8, source: "page" },
  activeMinutes: 20,
  fridgeDays: 3,
}

/** The options of dish `n` of the base week, with the changes of `overrides` (the enrichment merges). */
const baseDish = (n: number, overrides: Readonly<Record<number, DishOptions>> = {}): DishOptions => {
  const dish = BASE_DISHES[n]
  const change = overrides[n]
  return {
    ...dish,
    ...change,
    enrichment: {
      ...BASE_ENRICHMENT,
      ...dish?.enrichment,
      ...change?.enrichment,
    },
  }
}

const BASE_IDS: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7]

/** The 7 dishes of the base week. `overrides` replaces the options of a dish by ID (the enrichment merges). */
export const baseEntries = (
  overrides: Readonly<Record<number, DishOptions>> = {},
  aliases: Aliases = NO_ALIASES
): ReadonlyArray<CatalogueEntry> => BASE_IDS.map((n) => entryOf(n, { ...baseDish(n, overrides), aliases }))

/** The files `data/parsed/<n>.json` and `data/enriched/<n>.json` of the 7 dishes of the base week, for `writeFiles`. */
export const baseFiles = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    BASE_IDS.flatMap((n) => [
      [`data/parsed/${n}.json`, parsedJson(n, { title: baseDish(n).title ?? `Блюдо ${n}` })],
      [`data/enriched/${n}.json`, enrichedJson(n, baseDish(n))],
    ])
  )

export const baseCatalogue = (
  overrides: Readonly<Record<number, DishOptions>> = {},
  aliases: Aliases = NO_ALIASES
): Catalogue => catalogueOf(baseEntries(overrides, aliases), aliases)

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** A temporary directory for the test. It is removed at the end. `PlannerPaths` point to its `data` and `config`. */
export const withTempDir = <A, E>(
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | PlannerPaths>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "say7-planner-" })
    return yield* use(root).pipe(
      Effect.provide(PlannerPaths.layer({ dataDir: `${root}/data`, configDir: `${root}/config` }))
    )
  }).pipe(Effect.provide(platform))

/** Write the files `{ "<relative path>": "<text>" }` under `root`, with their directories. */
export const writeFiles = (root: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    for (const [relative, text] of Object.entries(files)) {
      const target = path.join(root, relative)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, text)
    }
  })

export const parsedJson = (n: number, options: Parameters<typeof parsedRecipe>[1] = {}): string =>
  Schema.encodeSync(ParsedRecipeJson)(parsedRecipe(n, options))

export const enrichedJson = (n: number, options: Pick<DishOptions, "ingredients" | "enrichment"> = {}): string =>
  Schema.encodeSync(EnrichedRecipeJson)(enrichedRecipe(n, options))
