import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { exitOnFailure, runCli } from "../cli/run.ts"
import { makeEvalCommand } from "./eval-cli-options.ts"
import { evaluate, readGold } from "./eval-run.ts"
import { enrichStoreLayer } from "./layers.ts"

const EXIT_ERRORS = 1

const command = makeEvalCommand((options) =>
  Effect.gen(function* () {
    const gold = yield* readGold(options.goldFile)
    yield* evaluate(gold).pipe(Effect.provide(enrichStoreLayer(options)))
  }).pipe(exitOnFailure("error", EXIT_ERRORS))
)

NodeRuntime.runMain(runCli(command, "error").pipe(Effect.provide(NodeServices.layer)))
