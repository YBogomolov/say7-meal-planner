import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, Effect } from "effect"
import { EVAL_USAGE, parseEvalCli } from "./eval-cli-options.ts"
import { evaluate, readGold } from "./eval-run.ts"
import { enrichStoreLayer } from "./layers.ts"

const EXIT_ERRORS = 1
const EXIT_USAGE = 2

const main = Effect.gen(function*() {
  const command = yield* Effect.fromResult(parseEvalCli(process.argv.slice(2)))
  if (command._tag === "Help") {
    yield* Console.log(EVAL_USAGE)
    return
  }
  const { options } = command
  const gold = yield* readGold(options.goldFile)
  yield* evaluate(gold).pipe(Effect.provide(enrichStoreLayer(options)))
}).pipe(
  Effect.provide(NodeFileSystem.layer),
  Effect.catch((error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(
        error._tag === "CliError" ? Console.error("Run `npm run enrich:eval -- --help` to see the options.") : Effect.void
      ),
      Effect.andThen(Effect.sync(() => {
        process.exitCode = error._tag === "CliError" ? EXIT_USAGE : EXIT_ERRORS
      }))
    )
  )
)

NodeRuntime.runMain(main)
