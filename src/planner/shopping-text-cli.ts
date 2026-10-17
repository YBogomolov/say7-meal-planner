import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, Effect, FileSystem, Path } from "effect"
import { loadCatalogue } from "./catalogue.ts"
import { parseShoppingTextCli, SHOPPING_TEXT_USAGE } from "./cli-options.ts"
import { loadHousehold, loadPlannerConfig } from "./config.ts"
import { plannerLayer } from "./layers.ts"
import { decodePlanJson, PlanInvalidError } from "./plans.ts"
import { shoppingList } from "./shopping.ts"
import { renderShoppingText } from "./shopping-render.ts"

const EXIT_NO_PLAN = 1
const EXIT_USAGE = 2

const main = Effect.gen(function* () {
  const command = yield* Effect.fromResult(parseShoppingTextCli(process.argv.slice(2)))
  if (command._tag === "Help") {
    yield* Console.log(SHOPPING_TEXT_USAGE)
    return
  }
  const { weekStart, withOptional, dataDir, configDir } = command.options
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
  for (const id of unknownOverrides) {
    yield* Console.warn(`предупреждение: в servings-overrides.json есть рецепт ${id}, которого нет в каталоге.`)
  }
  // Only the text goes to stdout, so that the output can be piped to `pbcopy`.
  const output = renderShoppingText(shoppingList(plan, catalogue, household), {
    withOptional,
  })
  yield* Console.log(output.replace(/\n$/, ""))
}).pipe(
  Effect.provide(plannerLayer),
  Effect.catch((error) =>
    Console.error(`ошибка: ${error.message}`).pipe(
      Effect.andThen(
        error._tag === "CliError" ? Console.error("Подсказка: `npm run shopping:text -- --help`.") : Effect.void
      ),
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = error._tag === "CliError" ? EXIT_USAGE : EXIT_NO_PLAN
        })
      )
    )
  )
)

NodeRuntime.runMain(main)
