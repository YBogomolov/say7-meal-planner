import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, DateTime, Effect, Path, Schema } from "effect"
import { ItemsReportJson } from "../domain/items-report.ts"
import type { ItemsReport } from "../domain/items-report.ts"
import { exitOnFailure, runCli } from "../cli/run.ts"
import { writeTextAtomic } from "../store/fs.ts"
import type { SkipReason, SkippedRecipe } from "./catalogue.ts"
import { SKIP_REASONS } from "./catalogue.ts"
import { makeItemsReportCommand } from "./cli-options.ts"
import { itemsReport } from "./items.ts"
import { plannerLayerFor } from "./layers.ts"
import { missingProteinItems } from "./protein.ts"
import { loadCatalogueWorld, warnUnknownOverrides } from "./world.ts"

const EXIT_FAILED = 1

const SKIP_LABELS: Readonly<Record<SkipReason, string>> = {
  no_parsed: "нет parsed-файла",
  no_enriched: "нет enriched-файла",
  invalid_parsed: "parsed-файл не годится",
  invalid_enriched: "enriched-файл не годится",
  not_a_meal: "не блюдо на обед или ужин",
}

/** `нет enriched-файла: 470, не блюдо на обед или ужин: 8` */
const skippedSummary = (skipped: ReadonlyArray<SkippedRecipe>): string =>
  SKIP_REASONS.map((reason) => [reason, skipped.filter((entry) => entry.reason === reason).length] as const)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${SKIP_LABELS[reason]}: ${count}`)
    .join(", ")

const command = makeItemsReportCommand((options) =>
  Effect.gen(function* () {
    const { dataDir } = options
    const path = yield* Path.Path
    const {
      config: { aliases },
      catalogue,
      skipped,
      unknownOverrides,
    } = yield* loadCatalogueWorld
    yield* warnUnknownOverrides(unknownOverrides)
    const items = itemsReport(catalogue)
    const missingProtein = missingProteinItems(catalogue)
    const report: ItemsReport = {
      version: 1,
      generatedAt: DateTime.formatIso(yield* DateTime.now),
      recipes: catalogue.entries.length,
      items,
      missingProtein,
    }
    const target = path.join(dataDir, "items-report.json")
    const text = yield* Schema.encodeEffect(ItemsReportJson)(report)
    yield* writeTextAtomic(target, `${text}\n`)

    yield* Console.log(
      `Каталог: ${catalogue.entries.length} рецептов. Пропущено: ${skipped.length}${skipped.length === 0 ? "" : ` (${skippedSummary(skipped)})`}.`
    )
    yield* Console.log(`Псевдонимов в config: ${aliases.size}. Продуктов после нормализации: ${items.length}.`)
    yield* Console.log(
      `Продуктов без записи в item-protein.json: ${missingProtein.length} (список: missingProtein в отчёте).`
    )
    yield* Console.log(`Отчёт записан: ${target}`)
  }).pipe(
    Effect.provide(plannerLayerFor({ dataDir: options.dataDir, configDir: options.configDir })),
    exitOnFailure("ошибка", EXIT_FAILED)
  )
)

NodeRuntime.runMain(runCli(command, "ошибка").pipe(Effect.provide(NodeServices.layer)))
