import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, Effect, FileSystem } from "effect"
import { loadCatalogue } from "./catalogue.ts"
import { parsePlanCheckCli, PLAN_CHECK_USAGE } from "./cli-options.ts"
import { loadHousehold, loadPlannerConfig } from "./config.ts"
import { evaluatePlan } from "./evaluate.ts"
import { plannerLayer } from "./layers.ts"
import { decodePlanJson, loadHistory, PlanInvalidError } from "./plans.ts"
import { formatEvaluation } from "./report.ts"
import { shoppingList } from "./shopping.ts"
import { renderShoppingList } from "./shopping-render.ts"

const EXIT_PLAN_HAS_ERRORS = 1
const EXIT_USAGE = 2

const main = Effect.gen(function*() {
  const command = yield* Effect.fromResult(parsePlanCheckCli(process.argv.slice(2)))
  if (command._tag === "Help") {
    yield* Console.log(PLAN_CHECK_USAGE)
    return
  }
  const { file, dataDir, configDir } = command.options
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError((error) => new PlanInvalidError({ message: `Файл ${file} не читается: ${error.message}` }))
  )
  const plan = yield* decodePlanJson(text)
  const [household, { aliases, overrides, proteinTable, extras }, history] = yield* Effect.all(
    [loadHousehold(configDir), loadPlannerConfig(configDir), loadHistory(dataDir)],
    { concurrency: "unbounded" }
  )
  const { catalogue, skipped, unknownOverrides } = yield* loadCatalogue(dataDir, aliases, overrides, proteinTable, extras)
  for (const id of unknownOverrides) {
    yield* Console.warn(`предупреждение: в servings-overrides.json есть рецепт ${id}, которого нет в каталоге.`)
  }

  const evaluation = evaluatePlan(plan, catalogue, household, history.plans)
  yield* Console.log(`Каталог: ${catalogue.entries.length} рецептов, пропущено ${skipped.length}. Сохранённых планов: ${history.plans.length}.`)
  for (const entry of history.skipped) {
    yield* Console.warn(`предупреждение: файл плана пропущен: ${entry.file}. ${entry.message}`)
  }
  yield* Console.log("")
  yield* Console.log(formatEvaluation(plan.weekStart, evaluation))
  yield* Console.log("---\n")
  yield* Console.log(renderShoppingList(shoppingList(plan, catalogue, household)))
  if (!evaluation.ok) {
    yield* Effect.sync(() => {
      process.exitCode = EXIT_PLAN_HAS_ERRORS
    })
  }
}).pipe(
  Effect.provide(plannerLayer),
  Effect.catch((error) =>
    Console.error(`ошибка: ${error.message}`).pipe(
      Effect.andThen(
        error._tag === "CliError" ? Console.error("Подсказка: `npm run plan:check -- --help`.") : Effect.void
      ),
      Effect.andThen(Effect.sync(() => {
        process.exitCode = error._tag === "CliError" ? EXIT_USAGE : EXIT_PLAN_HAS_ERRORS
      }))
    )
  )
)

NodeRuntime.runMain(main)
