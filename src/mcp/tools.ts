import { Effect, FileSystem, Path, Schema } from "effect"
import type { Catalogue } from "../domain/catalogue.ts"
import { RecipeId } from "../domain/recipe.ts"
import { WeekPlan } from "../domain/week-plan.ts"
import { writeTextAtomic } from "../planner/atomic.ts"
import { loadCatalogue, makeCatalogue } from "../planner/catalogue.ts"
import { loadAliases, loadHousehold, loadItemProtein, loadServingsOverrides } from "../planner/config.ts"
import { evaluatePlan } from "../planner/evaluate.ts"
import { loadHistory, savePlan } from "../planner/plans.ts"
import { portionProtein } from "../planner/protein.ts"
import { renderMenu } from "../planner/menu-render.ts"
import { searchRecipes, SearchQuery } from "../planner/search.ts"
import { shoppingList } from "../planner/shopping.ts"
import { renderShoppingList } from "../planner/shopping-render.ts"
import { defineTool } from "./tool.ts"
import type { Tool } from "./tool.ts"

export const DEFAULT_HISTORY_LIMIT = 4
const MAX_HISTORY_LIMIT = 52

/** The input of the tools that take a plan. */
export const PlanInput = Schema.Struct({ plan: WeekPlan })
export const GetRecipeInput = Schema.Struct({ id: RecipeId })
export const HistoryInput = Schema.Struct({
  /** Default 4. */
  limit: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY_LIMIT }))))
})
export const HouseholdInput = Schema.Struct({})

/** The state that the tools share: the directories and the catalogue, loaded once at the start. */
export interface World {
  readonly dataDir: string
  readonly configDir: string
  readonly catalogue: Catalogue
  /** The number of recipe files that the catalogue skipped. */
  readonly skipped: number
}

/** The Russian hint for an empty catalogue. */
export const EMPTY_CATALOGUE_HINT = (dataDir: string): string =>
  `Каталог пуст: в ${dataDir} нет разобранных и обогащённых рецептов. Запустите \`npm run scrape\`, \`npm run parse\` и \`npm run enrich\`, потом перезапустите сервер.`

/**
 * Load the aliases, the servings overrides, the protein table and the catalogue (like the CLIs do).
 * A catalogue that cannot be read (no directories) is empty: the server starts anyway. `warn` gets the Russian text of each problem.
 */
export const loadWorld = (
  dataDir: string,
  configDir: string,
  warn: (message: string) => void
): Effect.Effect<World, { readonly message: string }, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const aliases = yield* loadAliases(configDir)
    const overrides = yield* loadServingsOverrides(configDir)
    const proteinTable = yield* loadItemProtein(configDir, aliases)
    const loaded = yield* Effect.result(loadCatalogue(dataDir, aliases, overrides, proteinTable))
    if (loaded._tag === "Failure") {
      warn(loaded.failure.message)
      return { dataDir, configDir, catalogue: makeCatalogue([], aliases, undefined, proteinTable), skipped: 0 }
    }
    for (const id of loaded.success.unknownOverrides) {
      warn(`в servings-overrides.json есть рецепт ${id}, которого нет в каталоге.`)
    }
    return { dataDir, configDir, catalogue: loaded.success.catalogue, skipped: loaded.success.skipped.length }
  })

const json = (value: unknown): string => JSON.stringify(value)

/** The seven tools of spec P5.3. Each returns titles, links and facts, never the intro or the steps of a recipe (spec D6). */
export const makeTools = (world: World): ReadonlyArray<Tool<FileSystem.FileSystem | Path.Path>> => {
  const { dataDir, configDir, catalogue } = world

  const searchTool = defineTool({
    name: "search_recipes",
    description:
      "Поиск рецептов в каталоге по фильтрам (все необязательны). Возвращает компактные строки: id, название, ссылку, тип блюда, порции, время, нагрев, дни в холодильнике, продукты к покупке, белок на порцию в граммах (proteinPerPortion, оценка по таблице белка). Сортировка: popular или fewest_items. По умолчанию 20 строк, не больше 100.",
    input: SearchQuery,
    run: (query) =>
      Effect.succeed([
        json({
          catalogueSize: catalogue.entries.length,
          ...(catalogue.entries.length === 0 ? { hint: EMPTY_CATALOGUE_HINT(dataDir) } : {}),
          results: searchRecipes(catalogue, query)
        })
      ])
  })

  const getRecipeTool = defineTool({
    name: "get_recipe",
    description:
      "Карточка одного рецепта по id: название, ссылка, категория, обогащённые факты (порции, время, нагрев, оборудование, срок хранения) и строки ингредиентов, а также белок на порцию (protein.grams, г) и покрытие оценки (protein.coverage, 0–1; ниже 0,7 оценка неточная). Текста рецепта и шагов нет: они остаются на сайте.",
    input: GetRecipeInput,
    run: ({ id }) => {
      const entry = catalogue.byId.get(id)
      return entry === undefined
        ? Effect.fail({ message: `Рецепта ${id} нет в каталоге.` })
        : Effect.succeed([json({ ...entry, protein: portionProtein(entry, catalogue.proteinTable) })])
    }
  })

  const evaluateTool = defineTool({
    name: "evaluate_plan",
    description:
      "Проверяет план недели по правилам семьи (коды ошибок и предупреждений, показатели: buyItemCount, порции, активное время, белки, proteinPerSlot — белок по приёмам пищи в граммах; предупреждение low_protein, если белка в приёме мало). План с ошибками (ok: false) нельзя считать готовым.",
    input: PlanInput,
    run: ({ plan }) =>
      Effect.gen(function*() {
        const household = yield* loadHousehold(configDir)
        const history = yield* loadHistory(dataDir)
        return [json(evaluatePlan(plan, catalogue, household, history.plans))]
      })
  })

  const shoppingTool = defineTool({
    name: "shopping_list",
    description:
      "Список покупок для плана: JSON (разделы buy, optional, check_at_home, actions, dishes) и тот же список в Markdown. Ответ: JSON с полями list и markdown.",
    input: PlanInput,
    run: ({ plan }) =>
      Effect.gen(function*() {
        const household = yield* loadHousehold(configDir)
        const list = shoppingList(plan, catalogue, household)
        return [json({ list, markdown: renderShoppingList(list) })]
      })
  })

  const saveTool = defineTool({
    name: "save_plan",
    description:
      "Сохраняет план в data/plans/<weekStart>.json и меню в data/plans/<weekStart>.md (таблица дней, сессии готовки, оценка, список покупок). Сохраняется и план с ошибками правил: проверьте его через evaluate_plan до сохранения. План той же недели заменяется.",
    input: PlanInput,
    run: ({ plan }) =>
      Effect.gen(function*() {
        const path = yield* Path.Path
        const household = yield* loadHousehold(configDir)
        const history = yield* loadHistory(dataDir)
        const saved = yield* savePlan(dataDir, plan)
        const evaluation = evaluatePlan(saved.plan, catalogue, household, history.plans)
        const list = shoppingList(saved.plan, catalogue, household)
        const markdownPath = path.join(path.dirname(saved.path), `${saved.plan.weekStart}.md`)
        yield* writeTextAtomic(markdownPath, renderMenu({ plan: saved.plan, catalogue, household, evaluation, list }))
        return [
          json({
            weekStart: saved.plan.weekStart,
            jsonPath: saved.path,
            markdownPath,
            ok: evaluation.ok,
            errors: evaluation.errors.length,
            warnings: evaluation.warnings.length,
            buyItemCount: evaluation.metrics.buyItemCount
          })
        ]
      })
  })

  const historyTool = defineTool({
    name: "plan_history",
    description:
      `Последние сохранённые планы (по умолчанию ${DEFAULT_HISTORY_LIMIT}), новые первыми: weekStart, блюда (id, название, сессия, масштаб) и заметки.`,
    input: HistoryInput,
    run: ({ limit }) =>
      Effect.gen(function*() {
        const history = yield* loadHistory(dataDir)
        const last = history.plans.slice(-(limit ?? DEFAULT_HISTORY_LIMIT)).reverse()
        return [
          json({
            plans: last.map((plan) => ({
              weekStart: plan.weekStart,
              notes: plan.notes,
              dishes: plan.cooking.map((entry) => ({
                id: entry.recipeId,
                title: catalogue.byId.get(entry.recipeId)?.title ?? null,
                session: entry.session,
                scale: entry.scale
              }))
            })),
            skippedFiles: history.skipped.length
          })
        ]
      })
  })

  const householdTool = defineTool({
    name: "household",
    description: "Настройки семьи: персоны, дни, приёмы пищи, сессии готовки, лимиты нагрева, времени и белков.",
    input: HouseholdInput,
    run: () => loadHousehold(configDir).pipe(Effect.map((household) => [json(household)]))
  })

  return [searchTool, getRecipeTool, evaluateTool, shoppingTool, saveTool, historyTool, householdTool]
}
