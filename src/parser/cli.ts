import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, Effect } from "effect"
import { parseParseCli, USAGE } from "./cli-options.ts"
import { parserLayer } from "./layers.ts"
import { formatTotals, parseAll, warningSummary } from "./run.ts"

const EXIT_FAILED_PAGES = 1
const EXIT_USAGE = 2

const main = Effect.gen(function*() {
  const command = yield* Effect.fromResult(parseParseCli(process.argv.slice(2)))
  if (command._tag === "Help") {
    yield* Console.log(USAGE)
    return
  }
  const { options } = command
  const report = yield* parseAll(options).pipe(Effect.provide(parserLayer(options.dataDir)))

  yield* Console.log(`done: ${formatTotals(report)}`)
  const warnings = warningSummary(report)
  if (warnings.length > 0) {
    yield* Console.log(`warnings: ${warnings.join(", ")}`)
  }
  if (report.totals.failed > 0) {
    yield* Console.error(`${report.totals.failed} pages failed. The list is in ${options.dataDir}/parsed/_report.json.`)
    yield* Effect.sync(() => {
      process.exitCode = EXIT_FAILED_PAGES
    })
  }
}).pipe(
  Effect.catch((error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(
        error._tag === "CliError" ? Console.error("Run `npm run parse -- --help` to see the options.") : Effect.void
      ),
      Effect.andThen(Effect.sync(() => {
        process.exitCode = error._tag === "CliError" ? EXIT_USAGE : EXIT_FAILED_PAGES
      }))
    )
  )
)

NodeRuntime.runMain(main)
