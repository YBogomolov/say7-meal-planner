import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect, FileSystem } from "effect"
import { exitOnFailure, runCli, setExitCode } from "../cli/run.ts"
import { makePlanCheckCommand } from "./cli-options.ts"
import { evaluatePlan } from "./evaluate.ts"
import { plannerLayerFor } from "./layers.ts"
import { decodePlanJson, PlanInvalidError } from "./plans.ts"
import { formatEvaluation } from "./report.ts"
import { shoppingList } from "./shopping.ts"
import { renderShoppingList } from "./shopping-render.ts"
import { loadPlannerWorld, warnUnknownOverrides } from "./world.ts"

const EXIT_PLAN_HAS_ERRORS = 1

const command = makePlanCheckCommand((options) =>
  Effect.gen(function* () {
    const { file } = options
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
    const { household, history, catalogue, skipped, unknownOverrides } = yield* loadPlannerWorld({ history: true })
    yield* warnUnknownOverrides(unknownOverrides)

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
  }).pipe(
    Effect.provide(plannerLayerFor({ dataDir: options.dataDir, configDir: options.configDir })),
    exitOnFailure("ошибка", EXIT_PLAN_HAS_ERRORS)
  )
)

NodeRuntime.runMain(runCli(command, "ошибка").pipe(Effect.provide(NodeServices.layer)))
