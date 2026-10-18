import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Effect, Layer, Schema } from "effect"
import { plannerLayerFor } from "../planner/layers.ts"
import { createServer } from "./app.ts"
import { projectRoot, resolvePaths } from "./paths.ts"
import { loadWorld } from "./tools.ts"

/**
 * Entry of `npm run mcp`: a stdio MCP server (spec P5).
 * Stdout is the protocol: the log goes to stderr only.
 */

const log = (message: string): void => {
  process.stderr.write(`say7-mcp: ${message}\n`)
}

/** The environment variables are wrong. The message is logged as it is. */
class EnvironmentError extends Schema.TaggedError<EnvironmentError, { readonly brand: unique symbol }>()(
  "EnvironmentError",
  { message: Schema.String }
) {}

/** The server did not start: the data did not load or the transport did not connect. */
class StartupError extends Schema.TaggedError<StartupError, { readonly brand: unique symbol }>()("StartupError", {
  message: Schema.String,
}) {}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const main = Effect.gen(function* () {
  const { dataDir, configDir } = yield* Effect.fromResult(resolvePaths(projectRoot(import.meta.url), process.env)).pipe(
    Effect.mapError((message) => new EnvironmentError({ message }))
  )
  // The services are built once for the whole life of the server and are released with the scope.
  const services = yield* Layer.build(plannerLayerFor({ dataDir, configDir })).pipe(
    Effect.mapError((cause) => new StartupError({ message: describe(cause) }))
  )
  const world = yield* loadWorld((message) => log(`предупреждение: ${message}`)).pipe(
    Effect.provideContext(services),
    Effect.mapError((error) => new StartupError({ message: error.message }))
  )
  log(
    `каталог: ${world.catalogue.entries.length} рецептов, пропущено ${world.skipped}. Данные: ${dataDir}. Настройки: ${configDir}.`
  )
  const server = createServer(world, log, Effect.runPromiseWith(services))
  const closed = Effect.callback<void>((resume) => {
    server.server.onclose = () => resume(Effect.void)
  })
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => server.connect(new StdioServerTransport()),
      catch: (cause) => new StartupError({ message: describe(cause) }),
    }),
    () => Effect.promise(() => server.close())
  )
  log("сервер запущен (stdio).")
  // The stdin listener of the transport keeps the process alive. Wait here until the client closes the
  // connection. On SIGINT or SIGTERM `runMain` interrupts this fiber and the scope closes the server.
  yield* closed
}).pipe(
  Effect.scoped,
  Effect.catch((error) =>
    Effect.sync(() => {
      log(error._tag === "EnvironmentError" ? error.message : `ошибка запуска: ${error.message}`)
      process.exitCode = 1
    })
  )
)

NodeRuntime.runMain(main)
