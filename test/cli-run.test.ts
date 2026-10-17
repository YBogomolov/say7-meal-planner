import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import { Console, Effect, Schema } from "effect"
import { EXIT_USAGE, exitOnFailure, VERSION } from "../src/cli/run.ts"

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))
const SCRIPTS = [
  "src/scraper/cli.ts",
  "src/parser/cli.ts",
  "src/parser/fixtures-cli.ts",
  "src/enrich/cli.ts",
  "src/enrich/eval-cli.ts",
  "src/planner/items-cli.ts",
  "src/planner/servings-cli.ts",
  "src/planner/plan-cli.ts",
  "src/planner/shopping-text-cli.ts",
] as const

class Boom extends Schema.TaggedError<Boom>()("Boom", { message: Schema.String }) {}

const spawn = (script: string, args: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>((resolve) => {
        execFile(
          TSX,
          [fileURLToPath(new URL(`../${script}`, import.meta.url)), ...args],
          { timeout: 80_000 },
          (error, stdout, stderr) => {
            resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr })
          }
        )
      })
  )

describe("src/cli/run.ts", () => {
  it("prints the version of package.json", () => {
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
    assert.strictEqual(VERSION, version)
  })

  it.effect("exitOnFailure prints the message and sets the exit code of the script", () =>
    Effect.gen(function* () {
      const before = process.exitCode
      const errors: Array<string> = []
      const capture = {
        ...globalThis.console,
        error: (...parts: ReadonlyArray<unknown>) => void errors.push(parts.join(" ")),
      }
      yield* Effect.fail(new Boom({ message: "broken" })).pipe(
        exitOnFailure("error", 7),
        Effect.provideService(Console.Console, capture)
      )
      assert.strictEqual(process.exitCode, 7)
      assert.deepStrictEqual(errors, ["error: broken"])
      process.exitCode = before
    })
  )

  it.effect(
    "every script exits with 0 for --help and with 2 for an unknown flag",
    () =>
      Effect.gen(function* () {
        const results = yield* Effect.forEach(
          SCRIPTS,
          (script) =>
            Effect.all({ help: spawn(script, ["--help"]), bad: spawn(script, ["--nope"]) }).pipe(
              Effect.map((result) => ({ script, ...result }))
            ),
          { concurrency: "unbounded" }
        )
        for (const { script, help, bad } of results) {
          assert.strictEqual(help.code, 0, `${script} --help: ${help.stderr}`)
          assert.include(help.stdout, "--help", script)
          assert.strictEqual(bad.code, EXIT_USAGE, `${script} --nope`)
          assert.include(bad.stderr, "--nope", script)
        }
      }),
    90_000
  )
})
