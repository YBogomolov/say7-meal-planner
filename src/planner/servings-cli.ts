import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, DateTime, Effect, Path, Schema } from "effect"
import { ServingsReportJson } from "../domain/servings-report.ts"
import type { ServingsReport } from "../domain/servings-report.ts"
import { writeTextAtomic } from "../store/fs.ts"
import { loadCatalogue } from "./catalogue.ts"
import { parseServingsReportCli, SERVINGS_REPORT_USAGE } from "./cli-options.ts"
import { loadPlannerConfig } from "./config.ts"
import { plannerLayer } from "./layers.ts"
import { servingsAudit } from "./servings.ts"

const EXIT_FAILED = 1
const EXIT_USAGE = 2

const main = Effect.gen(function* () {
  const command = yield* Effect.fromResult(parseServingsReportCli(process.argv.slice(2)))
  if (command._tag === "Help") {
    yield* Console.log(SERVINGS_REPORT_USAGE)
    return
  }
  const { dataDir, configDir } = command.options
  const path = yield* Path.Path
  const { aliases, overrides, proteinTable, extras } = yield* loadPlannerConfig(configDir)
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
  const audit = servingsAudit(catalogue)
  const report: ServingsReport = {
    version: 1,
    generatedAt: DateTime.formatIso(yield* DateTime.now),
    recipes: audit.recipes,
    flagged: audit.entries.length,
    flaggedMainSoupSalad: audit.flaggedMainSoupSalad,
    reasons: audit.reasons,
    entries: audit.entries,
  }
  const target = path.join(dataDir, "servings-report.json")
  const text = yield* Schema.encodeEffect(ServingsReportJson)(report)
  yield* writeTextAtomic(target, `${text}\n`)

  yield* Console.log(
    `Каталог: ${audit.recipes} рецептов. Пропущено: ${skipped.length}. Переопределений порций: ${catalogue.overridden.size}.`
  )
  yield* Console.log(
    `Под подозрением: ${audit.entries.length}, из них основные блюда, супы и салаты: ${audit.flaggedMainSoupSalad}.`
  )
  yield* Console.log(
    `Причины: оценка модели ${audit.reasons.estimated}, больше 12 порций ${audit.reasons.max_above_12}, ` +
      `max больше 3 × min ${audit.reasons.range_above_3x}, масса порции вне 150–700 г ${audit.reasons.portion_mass_out_of_range}.`
  )
  yield* Console.log(`Отчёт записан: ${target}`)
}).pipe(
  Effect.provide(plannerLayer),
  Effect.catch((error) =>
    Console.error(`ошибка: ${error.message}`).pipe(
      Effect.andThen(
        error._tag === "CliError" ? Console.error("Подсказка: `npm run servings:report -- --help`.") : Effect.void
      ),
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = error._tag === "CliError" ? EXIT_USAGE : EXIT_FAILED
        })
      )
    )
  )
)

NodeRuntime.runMain(main)
