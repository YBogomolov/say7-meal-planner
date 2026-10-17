import { Effect, Schema } from "effect"
import { existsSync } from "node:fs"

export const DEFAULT_ENV_FILE = ".env"

export class EnvFileError extends Schema.TaggedError<EnvFileError>()("EnvFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * Load the variables of a `.env` file into the environment (spec A1).
 * A variable that the environment already has keeps its value.
 * The result is `false` if the file does not exist. The effect never prints a value.
 *
 * The code does this itself and does not use the Node flag `--env-file-if-exists`.
 * So it works the same with `npm run`, with `tsx` and with `node <file>.ts`.
 */
export const loadDotEnv = (file: string = DEFAULT_ENV_FILE): Effect.Effect<boolean, EnvFileError> =>
  Effect.try({
    try: () => {
      if (!existsSync(file)) {
        return false
      }
      process.loadEnvFile(file)
      return true
    },
    catch: (cause) =>
      new EnvFileError({
        path: file,
        message: cause instanceof Error ? cause.message : "Cannot read the file",
      }),
  })
