import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect } from "effect"
import { fileURLToPath } from "node:url"
import { exitOnFailure, runCli, setExitCode } from "../cli/run.ts"
import { makeFixturesCommand, refreshFixtures } from "./fixtures.ts"

const EXIT_ERRORS = 1

/** `test/fixtures/` of this project, whatever the working directory is. */
const FIXTURES_DIR = fileURLToPath(new URL("../../test/fixtures/", import.meta.url))

const command = makeFixturesCommand(({ dataDir }) =>
  Effect.gen(function* () {
    const summary = yield* refreshFixtures({
      idsFile: `${FIXTURES_DIR}real-ids.json`,
      sourceDir: `${dataDir}/raw`,
      targetDir: `${FIXTURES_DIR}real`,
    })
    yield* Console.log(`done: copied ${summary.copied.length}, missing ${summary.missing.length}`)
    if (summary.missing.length > 0) {
      yield* Console.error(
        `${summary.missing.length} pages are not in ${dataDir}/raw: ${summary.missing.join(", ")}. Run \`npm run scrape -- --ids ${summary.missing.join(",")}\` first.`
      )
      yield* setExitCode(EXIT_ERRORS)
    }
  }).pipe(exitOnFailure("error", EXIT_ERRORS))
)

NodeRuntime.runMain(runCli(command, "error").pipe(Effect.provide(NodeServices.layer)))
