import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect, FileSystem, Path } from "effect"
import { exitOnFailure, runCli } from "../cli/run.ts"
import { loadCatalogue } from "./catalogue.ts"
import { makeShoppingTextCommand } from "./cli-options.ts"
import { loadHousehold, loadPlannerConfig } from "./config.ts"
import { plannerLayer } from "./layers.ts"
import { decodePlanJson, PlanInvalidError } from "./plans.ts"
import { shoppingList } from "./shopping.ts"
import { renderShoppingText } from "./shopping-render.ts"

const EXIT_NO_PLAN = 1

const command = makeShoppingTextCommand((options) =>
  Effect.gen(function* () {
    const { weekStart, withOptional, dataDir, configDir } = options
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(dataDir, "plans", `${weekStart}.json`)
    if (!(yield* fs.exists(file))) {
      return yield* new PlanInvalidError({
        message: `План на неделю ${weekStart} не найден: ${file}. Сначала сохраните план.`,
      })
    }
    const text = yield* fs.readFileString(file).pipe(
      Effect.mapError(
        (error) =>
          new PlanInvalidError({
            message: `Файл ${file} не читается: ${error.message}`,
          })
      )
    )
    const plan = yield* decodePlanJson(text)
    const [household, { aliases, overrides, proteinTable, extras }] = yield* Effect.all(
      [loadHousehold(configDir), loadPlannerConfig(configDir)],
      { concurrency: "unbounded" }
    )
    const { catalogue, unknownOverrides } = yield* loadCatalogue(dataDir, aliases, overrides, proteinTable, extras)
    yield* Effect.forEach(
      unknownOverrides,
      (id) => Console.warn(`предупреждение: в servings-overrides.json есть рецепт ${id}, которого нет в каталоге.`),
      { discard: true }
    )
    // Only the text goes to stdout, so that the output can be piped to `pbcopy`.
    const output = renderShoppingText(shoppingList(plan, catalogue, household), {
      withOptional,
    })
    yield* Console.log(output.replace(/\n$/, ""))
  }).pipe(Effect.provide(plannerLayer), exitOnFailure("ошибка", EXIT_NO_PLAN))
)

NodeRuntime.runMain(runCli(command, "ошибка").pipe(Effect.provide(NodeServices.layer)))
