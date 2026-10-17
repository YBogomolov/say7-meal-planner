import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, Effect } from "effect"
import { parseCli, USAGE } from "./cli-options.ts"
import { scraperLayer } from "./layers.ts"
import { formatTotals, scrape } from "./run.ts"

const EXIT_ERRORS = 1
const EXIT_USAGE = 2

const main = Effect.gen(function* () {
  const command = yield* Effect.fromResult(parseCli(process.argv.slice(2)))
  if (command._tag === "Help") {
    yield* Console.log(USAGE)
    return
  }
  const { options } = command
  const summary = yield* scrape(options).pipe(Effect.provide(scraperLayer(options)))

  if (summary.errors > 0) {
    yield* Console.error(
      `${summary.errors} pages failed. Run the command again to retry them. (${formatTotals(summary)})`
    )
    yield* Effect.sync(() => {
      process.exitCode = EXIT_ERRORS
    })
  }
}).pipe(
  Effect.catch((error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(
        error._tag === "CliError" ? Console.error("Run `npm run scrape -- --help` to see the options.") : Effect.void
      ),
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = error._tag === "CliError" ? EXIT_USAGE : EXIT_ERRORS
        })
      )
    )
  )
)

NodeRuntime.runMain(main)
