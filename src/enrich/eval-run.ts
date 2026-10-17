import { Console, DateTime, Effect, FileSystem, Option, Schema } from "effect"
import { GoldJson } from "../domain/gold.ts"
import type { GoldEntry } from "../domain/gold.ts"
import type { EvalReport } from "../domain/enrich-eval.ts"
import { StoreError } from "../store/fs.ts"
import { buildEvalReport, formatEvalReport } from "./eval.ts"
import type { StoredEntry } from "./eval.ts"
import { EnrichStore } from "./store.ts"

/** Read `gold.json`. */
export const readGold = (file: string): Effect.Effect<ReadonlyArray<GoldEntry>, StoreError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((error) => new StoreError({ path: file, message: error.message })))
    return yield* Schema.decodeUnknownEffect(GoldJson)(text).pipe(
      Effect.mapError((error) => new StoreError({ path: file, message: error.message }))
    )
  })

/**
 * Score the stored enrichments of the gold recipes (spec P3.5, rule 2) and print the table.
 * The parsed file of a recipe gives the ingredient lines. The report goes to `<out-dir>/_eval.json`.
 */
export const evaluate = (gold: ReadonlyArray<GoldEntry>): Effect.Effect<EvalReport, StoreError, EnrichStore> =>
  Effect.gen(function* () {
    const store = yield* EnrichStore
    const entries = yield* Effect.forEach(
      gold,
      (entry): Effect.Effect<StoredEntry, StoreError> =>
        Effect.gen(function* () {
          const [stored, parsed] = yield* Effect.all(
            [store.readEnriched(entry.id), Effect.option(store.readParsed(entry.id))],
            { concurrency: "unbounded" }
          )
          return {
            gold: entry,
            stored,
            enrichment: Option.map(stored, (file) => file.enrichment),
            lines: Option.map(parsed, (recipe) => recipe.ingredientGroups.flatMap((group) => group.items)),
          }
        }),
      { concurrency: 8 }
    )
    const report = buildEvalReport(entries, DateTime.formatIso(yield* DateTime.now))
    yield* store.writeEval(report)
    for (const line of formatEvalReport(report)) {
      yield* Console.log(line)
    }
    return report
  })
