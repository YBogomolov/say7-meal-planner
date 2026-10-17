import { Effect, FileSystem, Path, Schema } from "effect"
import type { Catalogue } from "../domain/catalogue.ts"
import { RecipeId } from "../domain/recipe.ts"
import { WeekPlan } from "../domain/week-plan.ts"
import { writeTextAtomic } from "../store/fs.ts"
import { loadCatalogue, makeCatalogue } from "../planner/catalogue.ts"
import { loadHousehold, loadPlannerConfig } from "../planner/config.ts"
import { evaluatePlan } from "../planner/evaluate.ts"
import { PlannerPaths } from "../planner/paths.ts"
import { loadHistory, savePlan } from "../planner/plans.ts"
import { portionProtein, simpleProtein } from "../planner/protein.ts"
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
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY_LIMIT })))
  ),
})
export const HouseholdInput = Schema.Struct({})
export const SimpleBreakfastsInput = Schema.Struct({})

/** The state that the tools share: the directories and the catalogue, loaded once at the start. */
export interface World {
  readonly dataDir: string
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
  warn: (message: string) => void
): Effect.Effect<World, { readonly message: string }, FileSystem.FileSystem | Path.Path | PlannerPaths> =>
  Effect.gen(function* () {
    const { dataDir } = yield* PlannerPaths
    const config = yield* loadPlannerConfig()
    const { aliases, proteinTable, extras } = config
    const loaded = yield* Effect.result(loadCatalogue(config))
    if (loaded._tag === "Failure") {
      warn(loaded.failure.message)
      return {
        dataDir,
        catalogue: makeCatalogue([], aliases, undefined, proteinTable, extras.simpleBreakfasts),
        skipped: 0,
      }
    }
    for (const id of loaded.success.unknownOverrides) {
      warn(`в servings-overrides.json есть рецепт ${id}, которого нет в каталоге.`)
    }
    return {
      dataDir,
      catalogue: loaded.success.catalogue,
      skipped: loaded.success.skipped.length,
    }
  })

const json = (value: unknown): string => JSON.stringify(value)

/** The eight tools of spec P5.3 and P7.2.6. Each returns titles, links and facts, never the intro or the steps of a recipe (spec D6). */
export const makeTools = (world: World): ReadonlyArray<Tool<FileSystem.FileSystem | Path.Path | PlannerPaths>> => {
  const { dataDir, catalogue } = world

  const searchTool = defineTool({
    name: "search_recipes",
    description:
      "Поиск рецептов в каталоге по фильтрам (все необязательны). Возвращает компактные строки: id, название, ссылку, тип блюда, порции, время, нагрев, дни в холодильнике, продукты к покупке, белок на порцию в граммах (proteinPerPortion, оценка по таблице белка). Фильтр forMeal: breakfast (кандидаты на завтрак, в том числе блюда not_a_meal, которые годятся только для завтрака), lunch или dinner (без блюд not_a_meal); без forMeal блюда not_a_meal не показываются. Поле breakfastEligible показывает, годится ли блюдо для завтрака. Сортировка: popular или fewest_items. По умолчанию 20 строк, не больше 100.",
    input: SearchQuery,
    run: (query) =>
      Effect.succeed([
        json({
          catalogueSize: catalogue.entries.length,
          ...(catalogue.entries.length === 0 ? { hint: EMPTY_CATALOGUE_HINT(dataDir) } : {}),
          results: searchRecipes(catalogue, query),
        }),
      ]),
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
        : Effect.succeed([
            json({
              ...entry,
              protein: portionProtein(entry, catalogue.proteinTable),
            }),
          ])
    },
  })

  const evaluateTool = defineTool({
    name: "evaluate_plan",
    description:
      "Проверяет план недели по правилам семьи (коды ошибок и предупреждений, показатели: buyItemCount, порции, активное время сессий, белки, proteinPerSlot — белок по приёмам пищи в граммах; предупреждение low_protein, если белка в приёме мало). Завтраки: слот breakfast может содержать recipeIds и simpleIds (простые завтраки из simple_breakfasts); блюдо с session fresh готовится в день еды и допустимо только на завтрак (fresh_time, fresh_not_breakfast, unknown_simple, simple_not_breakfast, breakfast_only_recipe). План с ошибками (ok: false) нельзя считать готовым.",
    input: PlanInput,
    run: ({ plan }) =>
      Effect.gen(function* () {
        const [household, history] = yield* Effect.all([loadHousehold(), loadHistory()], {
          concurrency: "unbounded",
        })
        return [json(evaluatePlan(plan, catalogue, household, history.plans))]
      }),
  })

  const shoppingTool = defineTool({
    name: "shopping_list",
    description:
      "Список покупок для плана: JSON (разделы buy, optional, check_at_home, actions, dishes, simpleBreakfasts) и тот же список в Markdown. Свежие блюда умножаются на число дней, простые завтраки — на число персон слота; в позиции recipeIds — блюда, simpleIds — простые завтраки. Ответ: JSON с полями list и markdown.",
    input: PlanInput,
    run: ({ plan }) =>
      Effect.gen(function* () {
        const household = yield* loadHousehold()
        const list = shoppingList(plan, catalogue, household)
        return [json({ list, markdown: renderShoppingList(list) })]
      }),
  })

  const saveTool = defineTool({
    name: "save_plan",
    description:
      "Сохраняет план в data/plans/<weekStart>.json и меню в data/plans/<weekStart>.md (таблица дней с завтраками, сессии готовки и свежие блюда, оценка, список покупок). Сохраняется и план с ошибками правил: проверьте его через evaluate_plan до сохранения. План той же недели заменяется.",
    input: PlanInput,
    run: ({ plan }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const [household, history] = yield* Effect.all([loadHousehold(), loadHistory()], {
          concurrency: "unbounded",
        })
        const saved = yield* savePlan(plan)
        const evaluation = evaluatePlan(saved.plan, catalogue, household, history.plans)
        const list = shoppingList(saved.plan, catalogue, household)
        const markdownPath = path.join(path.dirname(saved.path), `${saved.plan.weekStart}.md`)
        yield* writeTextAtomic(
          markdownPath,
          renderMenu({
            plan: saved.plan,
            catalogue,
            household,
            evaluation,
            list,
          })
        )
        return [
          json({
            weekStart: saved.plan.weekStart,
            jsonPath: saved.path,
            markdownPath,
            ok: evaluation.ok,
            errors: evaluation.errors.length,
            warnings: evaluation.warnings.length,
            buyItemCount: evaluation.metrics.buyItemCount,
          }),
        ]
      }),
  })

  const historyTool = defineTool({
    name: "plan_history",
    description: `Последние сохранённые планы (по умолчанию ${DEFAULT_HISTORY_LIMIT}), новые первыми: weekStart, блюда (id, название, сессия A, B или fresh, масштаб), простые завтраки (simpleIds) и заметки.`,
    input: HistoryInput,
    run: ({ limit }) =>
      Effect.gen(function* () {
        const history = yield* loadHistory()
        const last = history.plans.slice(-(limit ?? DEFAULT_HISTORY_LIMIT)).reverse()
        return [
          json({
            plans: last.map((plan) => ({
              weekStart: plan.weekStart,
              notes: plan.notes,
              simpleIds: [...new Set(plan.meals.flatMap((meal) => meal.simpleIds))].sort(),
              dishes: plan.cooking.map((entry) => ({
                id: entry.recipeId,
                title: catalogue.byId.get(entry.recipeId)?.title ?? null,
                session: entry.session,
                scale: entry.scale,
              })),
            })),
            skippedFiles: history.skipped.length,
          }),
        ]
      }),
  })

  const householdTool = defineTool({
    name: "household",
    description:
      "Настройки семьи: персоны, дни, приёмы пищи (в том числе завтрак), персоны по приёмам (mealPersons), сессии готовки, лимиты нагрева, времени (в том числе freshMinutesMax для свежих блюд завтрака) и белков (proteinMinGrams).",
    input: HouseholdInput,
    run: () => loadHousehold().pipe(Effect.map((household) => [json(household)])),
  })

  const simpleTool = defineTool({
    name: "simple_breakfasts",
    description:
      "Простые завтраки из config/simple-breakfasts.json: id, название, белок на порцию в граммах (proteinPerPortion, coverage — покрытие оценки, 0–1) и продукты на одну порцию (item, grams, category, pantry). Положите id в simpleIds слота breakfast; готовить и записывать в cooking не нужно.",
    input: SimpleBreakfastsInput,
    run: () =>
      Effect.succeed([
        json({
          simpleBreakfasts: catalogue.simpleBreakfasts.map((simple) => {
            const protein = simpleProtein(simple, catalogue.proteinTable)
            return {
              id: simple.id,
              title: simple.title,
              proteinPerPortion: protein.grams,
              coverage: protein.coverage,
              items: simple.items,
            }
          }),
        }),
      ]),
  })

  return [searchTool, getRecipeTool, evaluateTool, shoppingTool, saveTool, historyTool, householdTool, simpleTool]
}
