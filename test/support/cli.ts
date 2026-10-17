import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert } from "@effect/vitest"
import { Console, Effect, Option, Ref } from "effect"
import { CliError, Command } from "effect/cli"
import { VERSION } from "../../src/cli/run.ts"
import type { UsageError } from "../../src/cli/run.ts"

/** What `Command.runWith` did: the value that the handler got, the failure, and the text on stdout and stderr. */
export interface CliOutcome<A> {
  readonly value: Option.Option<A>
  readonly failure: Option.Option<CliError.CliError | UsageError>
  readonly stdout: string
  readonly stderr: string
}

/** Builds a command whose handler gets the parsed value. The value of a test is the parsed options. */
export type MakeCommand<A, Name extends string, Input, ContextInput> = (
  handler: (value: A) => Effect.Effect<void>
) => Command.Command<Name, Input, ContextInput, UsageError, never>

/**
 * Test tools for one command. Call it as `commandTester<CliOptions>()(makeScrapeCommand)`:
 * the first call names the type of the parsed value (TypeScript cannot infer it from a generic factory).
 */
export const commandTester =
  <A>() =>
  <Name extends string, Input, ContextInput>(make: MakeCommand<A, Name, Input, ContextInput>) => {
    /** Run the command like `Command.run` does, with the given arguments and a handler that records its input. */
    const run = (argv: ReadonlyArray<string>): Effect.Effect<CliOutcome<A>> =>
      Effect.gen(function* () {
        const recorded = yield* Ref.make(Option.none<A>())
        const stdout: Array<string> = []
        const stderr: Array<string> = []
        const capture = {
          ...globalThis.console,
          log: (...parts: ReadonlyArray<unknown>) => void stdout.push(parts.join(" ")),
          error: (...parts: ReadonlyArray<unknown>) => void stderr.push(parts.join(" ")),
        }
        const command = make((value) => Ref.set(recorded, Option.some(value)))
        const result = yield* Command.runWith(command, { version: VERSION })(argv).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(Console.Console, capture),
          Effect.result
        )
        return {
          value: yield* Ref.get(recorded),
          failure: result._tag === "Failure" ? Option.some(result.failure) : Option.none(),
          stdout: stdout.join("\n"),
          stderr: stderr.join("\n"),
        }
      })

    /** The value that the handler got. The test fails if the arguments are rejected. */
    const parsed = (argv: ReadonlyArray<string>): Effect.Effect<A> =>
      run(argv).pipe(
        Effect.map((outcome) =>
          Option.isSome(outcome.value) && Option.isNone(outcome.failure)
            ? outcome.value.value
            : assert.fail(`expected success for ${argv.join(" ")}, got: ${outcome.stderr}`)
        )
      )

    /** The reason of the rejection (stderr, or the message of a usage error). The test fails if the handler runs. */
    const rejection = (argv: ReadonlyArray<string>): Effect.Effect<string> =>
      run(argv).pipe(
        Effect.map((outcome) => {
          if (Option.isSome(outcome.value) || Option.isNone(outcome.failure)) {
            return assert.fail(`expected a usage error for ${argv.join(" ")}`)
          }
          const failure = outcome.failure.value
          return failure._tag === "UsageError" ? failure.message : outcome.stderr
        })
      )

    /** The help text. The handler does not run, and the help is not an error (exit code 0). */
    const help = (argv: ReadonlyArray<string> = ["--help"]): Effect.Effect<string> =>
      run(argv).pipe(
        Effect.map((outcome) => {
          const isHelp = Option.isNone(outcome.value) && Option.isNone(outcome.failure) && outcome.stdout !== ""
          return isHelp ? outcome.stdout : assert.fail(`expected help for ${argv.join(" ")}`)
        })
      )

    return { run, parsed, rejection, help }
  }
