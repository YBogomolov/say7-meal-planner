import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, DateTime, Effect, Path, Schema } from "effect"
import { ServingsReportJson } from "../domain/servings-report.ts"
import type { ServingsReport } from "../domain/servings-report.ts"
import { exitOnFailure, runCli } from "../cli/run.ts"
import { writeTextAtomic } from "../store/fs.ts"
import { makeServingsReportCommand } from "./cli-options.ts"
import { plannerLayerFor } from "./layers.ts"
import { servingsAudit } from "./servings.ts"
import { loadCatalogueWorld, warnUnknownOverrides } from "./world.ts"

const EXIT_FAILED = 1

const command = makeServingsReportCommand((options) =>
  Effect.gen(function* () {
    const { dataDir } = options
    const path = yield* Path.Path
    const { catalogue, skipped, unknownOverrides } = yield* loadCatalogueWorld
    yield* warnUnknownOverrides(unknownOverrides)
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
    Effect.provide(plannerLayerFor({ dataDir: options.dataDir, configDir: options.configDir })),
    exitOnFailure("ошибка", EXIT_FAILED)
  )
)

NodeRuntime.runMain(runCli(command, "ошибка").pipe(Effect.provide(NodeServices.layer)))
