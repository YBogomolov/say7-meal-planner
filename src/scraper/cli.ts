import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect } from "effect"
import { exitOnFailure, runCli, setExitCode } from "../cli/run.ts"
import { makeScrapeCommand } from "./cli-options.ts"
import { scraperLayer } from "./layers.ts"
import { formatTotals, scrape } from "./run.ts"

const EXIT_ERRORS = 1

const command = makeScrapeCommand((options) =>
  Effect.gen(function* () {
    const summary = yield* scrape(options).pipe(Effect.provide(scraperLayer(options)))
    if (summary.errors > 0) {
      yield* Console.error(
        `${summary.errors} pages failed. Run the command again to retry them. (${formatTotals(summary)})`
      )
      yield* setExitCode(EXIT_ERRORS)
    }
  }).pipe(exitOnFailure("error", EXIT_ERRORS))
)

NodeRuntime.runMain(runCli(command, "error").pipe(Effect.provide(NodeServices.layer)))
