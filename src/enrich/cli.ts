import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect, Layer } from "effect"
import { exitOnFailure, runCli, setExitCode } from "../cli/run.ts"
import { makeEnrichCommand } from "./cli-options.ts"
import { loadDotEnv } from "./env.ts"
import { enrichStoreLayer, llmLayer } from "./layers.ts"
import { dryRun, enrichAll } from "./run.ts"

const EXIT_FAILURES = 1

const command = makeEnrichCommand((cli) =>
  Effect.gen(function* () {
    if (cli._tag === "DryRun") {
      const summary = yield* dryRun(cli.options).pipe(Effect.provide(enrichStoreLayer(cli.options)))
      if (summary.problems.length > 0) {
        yield* setExitCode(EXIT_FAILURES)
      }
      return
    }
    const { options } = cli
    yield* loadDotEnv()
    const store = enrichStoreLayer(options)
    const { report } = yield* enrichAll(options).pipe(Effect.provide(Layer.mergeAll(store, llmLayer)))
    if (report.totals.failed > 0) {
      yield* Console.error(
        `${report.totals.failed} recipes have no valid enrichment. The list is in ${options.outDir}/_report.json. ` +
          `To try them again, run: npm run enrich -- --model ${options.model} --retry-failed`
      )
      yield* setExitCode(EXIT_FAILURES)
    }
  }).pipe(exitOnFailure("error", EXIT_FAILURES))
)

NodeRuntime.runMain(runCli(command, "error").pipe(Effect.provide(NodeServices.layer)))
