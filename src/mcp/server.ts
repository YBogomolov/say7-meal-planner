import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Effect, Result } from "effect"
import { plannerLayer } from "../planner/layers.ts"
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

const main = async (): Promise<void> => {
  const paths = resolvePaths(projectRoot(import.meta.url), process.env)
  if (Result.isFailure(paths)) {
    log(paths.failure)
    process.exitCode = 1
    return
  }
  const { dataDir, configDir } = paths.success
  const world = await Effect.runPromise(
    loadWorld(dataDir, configDir, (message) => log(`предупреждение: ${message}`)).pipe(Effect.provide(plannerLayer))
  )
  log(`каталог: ${world.catalogue.entries.length} рецептов, пропущено ${world.skipped}. Данные: ${dataDir}. Настройки: ${configDir}.`)
  const server = createServer(world, log)
  await server.connect(new StdioServerTransport())
  log("сервер запущен (stdio).")
}

main().catch((cause: unknown) => {
  log(`ошибка запуска: ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exitCode = 1
})
