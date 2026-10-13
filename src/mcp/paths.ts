import { Result, Schema } from "effect"
import { fileURLToPath } from "node:url"
import * as nodePath from "node:path"

/** The project root: the directory above `src/mcp`, found from the location of the server file, not from the working directory. */
export const projectRoot = (moduleUrl: string): string => nodePath.resolve(nodePath.dirname(fileURLToPath(moduleUrl)), "..", "..")

const Environment = Schema.Struct({
  SAY7_DATA_DIR: Schema.optionalKey(Schema.NonEmptyString),
  SAY7_CONFIG_DIR: Schema.optionalKey(Schema.NonEmptyString)
})

export interface ServerPaths {
  readonly root: string
  readonly dataDir: string
  readonly configDir: string
}

/**
 * The directories of the server: `<root>/data` and `<root>/config`.
 * `SAY7_DATA_DIR` and `SAY7_CONFIG_DIR` replace them (a relative path is relative to the working directory). An empty value is an error.
 */
export const resolvePaths = (root: string, env: Readonly<Record<string, string | undefined>>): Result.Result<ServerPaths, string> =>
  Schema.decodeUnknownResult(Environment)({
    ...(env["SAY7_DATA_DIR"] === undefined ? {} : { SAY7_DATA_DIR: env["SAY7_DATA_DIR"] }),
    ...(env["SAY7_CONFIG_DIR"] === undefined ? {} : { SAY7_CONFIG_DIR: env["SAY7_CONFIG_DIR"] })
  }).pipe(
    Result.map((decoded) => ({
      root,
      dataDir: nodePath.resolve(decoded.SAY7_DATA_DIR ?? nodePath.join(root, "data")),
      configDir: nodePath.resolve(decoded.SAY7_CONFIG_DIR ?? nodePath.join(root, "config"))
    })),
    Result.mapError((error) => `Неверные переменные окружения.\n${error.message}`)
  )
