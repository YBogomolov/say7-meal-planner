import { Console, Effect, Schema } from "effect"
import { CliError, Command } from "effect/cli"

/** The version that `--version` prints. The test `cli-run.test.ts` keeps it equal to `package.json`. */
export const VERSION = "0.1.0"

/** Exit code of a bad flag, value or argument. */
export const EXIT_USAGE = 2

/** A usage error that the flag parser cannot find, for example two flags that do not go together. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

/** Set the exit code of the process. The process keeps running. */
export const setExitCode = (code: number): Effect.Effect<void> =>
  Effect.sync(() => {
    process.exitCode = code
  })

/**
 * Handle every failure of a command handler: print `<label>: <message>` to stderr and set the exit code.
 * `label` is `error` or `ошибка`; `code` is the exit code of the script for a domain failure.
 */
export const exitOnFailure =
  (label: string, code: number) =>
  <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
    effect.pipe(
      Effect.catch((error) => Console.error(`${label}: ${error.message}`).pipe(Effect.andThen(setExitCode(code))))
    )

/**
 * Run a command with the arguments of the process. `--help` prints the help and exits with 0.
 * A usage error (bad flag, bad value, missing argument) exits with 2: effect/cli prints the help and the reason first.
 */
export const runCli = <Name extends string, Input, ContextInput, R>(
  command: Command.Command<Name, Input, ContextInput, UsageError, R>,
  label: string
) =>
  Command.run(command, { version: VERSION }).pipe(
    Effect.catch((error) => {
      if (error._tag === "UsageError") {
        return Console.error(`${label}: ${error.message}`).pipe(Effect.andThen(setExitCode(EXIT_USAGE)))
      }
      // `ShowHelp` without errors is `--help`: effect/cli printed the help already.
      return CliError.isCliError(error) && error._tag === "ShowHelp" && error.errors.length === 0
        ? Effect.void
        : setExitCode(EXIT_USAGE)
    })
  )
