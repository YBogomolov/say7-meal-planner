import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect, FileSystem } from "effect"
import { exitOnFailure, runCli, setExitCode } from "../cli/run.ts"
import { loadCatalogue } from "./catalogue.ts"
import { makePlanCheckCommand } from "./cli-options.ts"
import { loadHousehold, loadPlannerConfig } from "./config.ts"
import { evaluatePlan } from "./evaluate.ts"
import { plannerLayer } from "./layers.ts"
import { decodePlanJson, loadHistory, PlanInvalidError } from "./plans.ts"
import { formatEvaluation } from "./report.ts"
import { shoppingList } from "./shopping.ts"
import { renderShoppingList } from "./shopping-render.ts"

const EXIT_PLAN_HAS_ERRORS = 1

const command = makePlanCheckCommand((options) =>
  Effect.gen(function* () {
    const { file, dataDir, configDir } = options
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file).pipe(
      Effect.mapError(
        (error) =>
          new PlanInvalidError({
            message: `Файл ${file} не читается: ${error.message}`,
          })
      )
    )
    const plan = yield* decodePlanJson(text)
    const [household, { aliases, overrides, proteinTable, extras }, history] = yield* Effect.all(
      [loadHousehold(configDir), loadPlannerConfig(configDir), loadHistory(dataDir)],
      { concurrency: "unbounded" }
    )
    const { catalogue, skipped, unknownOverrides } = yield* loadCatalogue(
      dataDir,
      aliases,
      overrides,
      proteinTable,
      extras
    )
    yield* Effect.forEach(
      unknownOverrides,
      (id) => Console.warn(`предупреждение: в servings-overrides.json есть рецепт ${id}, которого нет в каталоге.`),
      { discard: true }
    )

    const evaluation = evaluatePlan(plan, catalogue, household, history.plans)
    yield* Console.log(
      `Каталог: ${catalogue.entries.length} рецептов, пропущено ${skipped.length}. Сохранённых планов: ${history.plans.length}.`
    )
    yield* Effect.forEach(
      history.skipped,
      (entry) => Console.warn(`предупреждение: файл плана пропущен: ${entry.file}. ${entry.message}`),
      { discard: true }
    )
    yield* Console.log("")
    yield* Console.log(formatEvaluation(plan.weekStart, evaluation))
    yield* Console.log("---\n")
    yield* Console.log(renderShoppingList(shoppingList(plan, catalogue, household)))
    if (!evaluation.ok) {
      yield* setExitCode(EXIT_PLAN_HAS_ERRORS)
    }
  }).pipe(Effect.provide(plannerLayer), exitOnFailure("ошибка", EXIT_PLAN_HAS_ERRORS))
)

NodeRuntime.runMain(runCli(command, "ошибка").pipe(Effect.provide(NodeServices.layer)))
