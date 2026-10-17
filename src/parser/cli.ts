import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect } from "effect"
import { exitOnFailure, runCli, setExitCode } from "../cli/run.ts"
import { makeParseCommand } from "./cli-options.ts"
import { parserLayer } from "./layers.ts"
import { formatTotals, parseAll, warningSummary } from "./run.ts"

const EXIT_FAILED_PAGES = 1

const command = makeParseCommand((options) =>
  Effect.gen(function* () {
    const report = yield* parseAll(options).pipe(Effect.provide(parserLayer(options.dataDir)))

    yield* Console.log(`done: ${formatTotals(report)}`)
    const warnings = warningSummary(report)
    if (warnings.length > 0) {
      yield* Console.log(`warnings: ${warnings.join(", ")}`)
    }
    if (report.totals.failed > 0) {
      yield* Console.error(
        `${report.totals.failed} pages failed. The list is in ${options.dataDir}/parsed/_report.json.`
      )
      yield* setExitCode(EXIT_FAILED_PAGES)
    }
  }).pipe(exitOnFailure("error", EXIT_FAILED_PAGES))
)

NodeRuntime.runMain(runCli(command, "error").pipe(Effect.provide(NodeServices.layer)))
