import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Console, Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import { FIXTURES_USAGE, parseFixturesCli, refreshFixtures } from "./fixtures.ts"

const EXIT_ERRORS = 1
const EXIT_USAGE = 2

/** `test/fixtures/` of this project, whatever the working directory is. */
const FIXTURES_DIR = fileURLToPath(new URL("../../test/fixtures/", import.meta.url))

const main = Effect.gen(function* () {
  const command = yield* Effect.fromResult(parseFixturesCli(process.argv.slice(2)))
  if (command._tag === "Help") {
    yield* Console.log(FIXTURES_USAGE)
    return
  }
  const summary = yield* refreshFixtures({
    idsFile: `${FIXTURES_DIR}real-ids.json`,
    sourceDir: `${command.dataDir}/raw`,
    targetDir: `${FIXTURES_DIR}real`,
  })
  yield* Console.log(`done: copied ${summary.copied.length}, missing ${summary.missing.length}`)
  if (summary.missing.length > 0) {
    yield* Console.error(
      `${summary.missing.length} pages are not in ${command.dataDir}/raw: ${summary.missing.join(", ")}. Run \`npm run scrape -- --ids ${summary.missing.join(",")}\` first.`
    )
    yield* Effect.sync(() => {
      process.exitCode = EXIT_ERRORS
    })
  }
}).pipe(
  Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  Effect.catch((error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(
        error._tag === "CliError"
          ? Console.error("Run `npm run fixtures:refresh -- --help` to see the options.")
          : Effect.void
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
