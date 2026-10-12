import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, Effect, Layer } from "effect"
import { parseEnrichCli, USAGE } from "./cli-options.ts"
import { loadDotEnv } from "./env.ts"
import { enrichStoreLayer, llmLayer } from "./layers.ts"
import { dryRun, enrichAll } from "./run.ts"

const EXIT_FAILURES = 1
const EXIT_USAGE = 2

const main = Effect.gen(function*() {
  const command = yield* Effect.fromResult(parseEnrichCli(process.argv.slice(2)))
  if (command._tag === "Help") {
    yield* Console.log(USAGE)
    return
  }
  if (command._tag === "DryRun") {
    const summary = yield* dryRun(command.options).pipe(Effect.provide(enrichStoreLayer(command.options)))
    if (summary.problems.length > 0) {
      yield* Effect.sync(() => {
        process.exitCode = EXIT_FAILURES
      })
    }
    return
  }
  const { options } = command
  yield* loadDotEnv()
  const store = enrichStoreLayer(options)
  const { report } = yield* enrichAll(options).pipe(Effect.provide(Layer.mergeAll(store, llmLayer)))
  if (report.totals.failed > 0) {
    yield* Console.error(
      `${report.totals.failed} recipes have no valid enrichment. The list is in ${options.outDir}/_report.json. ` +
        `To try them again, run: npm run enrich -- --model ${options.model} --retry-failed`
    )
    yield* Effect.sync(() => {
      process.exitCode = EXIT_FAILURES
    })
  }
}).pipe(
  Effect.catch((error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(
        error._tag === "CliError" ? Console.error("Run `npm run enrich -- --help` to see the options.") : Effect.void
      ),
      Effect.andThen(Effect.sync(() => {
        process.exitCode = error._tag === "CliError" ? EXIT_USAGE : EXIT_FAILURES
      }))
    )
  )
)

NodeRuntime.runMain(main)
