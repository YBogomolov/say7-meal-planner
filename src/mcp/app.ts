import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js"
import { Effect, Result } from "effect"
import { plannerLayer } from "../planner/layers.ts"
import {
  decodePlanWeekArguments,
  PLAN_WEEK_ARGUMENTS,
  PLAN_WEEK_DESCRIPTION,
  PLAN_WEEK_PROMPT,
  planWeekPrompt
} from "./prompt.ts"
import { makeTools } from "./tools.ts"
import type { World } from "./tools.ts"

export const SERVER_NAME = "say7-meal-planner"
export const SERVER_VERSION = "0.1.0"

/**
 * The MCP server with the tools of spec P5.3 and the prompt `plan_week`, on top of the loaded `world`.
 * `McpServer.registerTool` accepts only Zod schemas. So the handlers go on the low-level `server` of `McpServer`,
 * and the JSON Schemas of the tools come from Effect Schema.
 * `log` writes to stderr (stdout is the protocol).
 */
export const createServer = (world: World, log: (message: string) => void): McpServer => {
  const tools = makeTools(world)
  const mcpServer = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions:
        "Планировщик меню на неделю по рецептам say7.info. Начните с промпта plan_week или с инструментов household и plan_history. Инструменты возвращают названия, ссылки и факты, без текстов рецептов."
    }
  )
  const { server } = mcpServer

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: raw } = request.params
    const tool = tools.find((candidate) => candidate.name === name)
    if (tool === undefined) {
      return { content: [{ type: "text", text: `Неизвестный инструмент: ${name}.` }], isError: true }
    }
    const result = await Effect.runPromise(tool.call(raw).pipe(Effect.provide(plannerLayer)))
    if (result.isError) {
      log(`инструмент ${name}: ошибка`)
    }
    return { content: result.texts.map((text) => ({ type: "text", text })), isError: result.isError }
  })

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [{ name: PLAN_WEEK_PROMPT, description: PLAN_WEEK_DESCRIPTION, arguments: [...PLAN_WEEK_ARGUMENTS] }]
  }))

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    if (request.params.name !== PLAN_WEEK_PROMPT) {
      throw new Error(`Неизвестный промпт: ${request.params.name}.`)
    }
    const decoded = decodePlanWeekArguments(request.params.arguments)
    if (Result.isFailure(decoded)) {
      throw new Error(decoded.failure)
    }
    const { weekStart, proteinFamily } = decoded.success
    return {
      description: PLAN_WEEK_DESCRIPTION,
      messages: [{ role: "user", content: { type: "text", text: planWeekPrompt(weekStart, proteinFamily) } }]
    }
  })

  return mcpServer
}
