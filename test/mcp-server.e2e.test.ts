import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { baseFiles, basePlan } from "./support/planner.ts"

/** The real server `src/mcp/server.ts` in a child process, an SDK client over stdio, and a synthetic data directory. */

const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
const SERVER = fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))
const STARTUP_MS = 60_000
const CASE_MS = 30_000

interface Running {
  readonly client: Client
  readonly close: () => Promise<void>
}

const startServer = async (cwd: string, dataDir: string, configDir: string): Promise<Running> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER],
    cwd,
    env: { SAY7_DATA_DIR: dataDir, SAY7_CONFIG_DIR: configDir, PATH: process.env["PATH"] ?? "" },
    stderr: "ignore"
  })
  const client = new Client({ name: "say7-test", version: "0.0.0" })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

/** The text blocks of a tool result. */
const textsOf = (result: CallToolResult): ReadonlyArray<string> =>
  result.content.flatMap((block) => block.type === "text" ? [block.text] : [])

const call = async (running: Running, name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
  CallToolResultSchema.parse(await running.client.callTool({ name, arguments: args }))

const parse = (text: string | undefined): unknown => JSON.parse(text ?? "null")

let root = ""
let dataDir = ""
let main: Running
let empty: Running

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "say7-mcp-"))
  dataDir = join(root, "data")
  for (const [relative, text] of Object.entries(baseFiles())) {
    const target = join(root, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  const configDir = join(root, "config")
  main = await startServer(root, dataDir, configDir)
  mkdirSync(join(root, "empty-data"), { recursive: true })
  empty = await startServer(root, join(root, "empty-data"), configDir)
}, STARTUP_MS)

afterAll(async () => {
  await main?.close()
  await empty?.close()
  rmSync(root, { recursive: true, force: true })
})

describe("MCP server over stdio", () => {
  it("lists the 7 tools with object input schemas", async () => {
    const { tools } = await main.client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "evaluate_plan",
      "get_recipe",
      "household",
      "plan_history",
      "save_plan",
      "search_recipes",
      "shopping_list"
    ])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object")
    }
    const search = tools.find((tool) => tool.name === "search_recipes")
    expect(Object.keys(search?.inputSchema.properties ?? {})).toContain("proteinFamilies")
  }, CASE_MS)

  it("search_recipes finds a dish by a word of the title or an item, with links and no texts", async () => {
    const result = await call(main, "search_recipes", { text: "курица" })
    expect(result.isError).toBeFalsy()
    const body = parse(textsOf(result)[0])
    expect(body).toMatchObject({ catalogueSize: 7 })
    const text = textsOf(result)[0] ?? ""
    expect(text).toContain("https://www.say7.info/cook/recipe/1-")
    expect(text).toContain("Суп Альфа")
    expect(text).not.toContain("intro")
    expect(text).not.toContain("steps")
  }, CASE_MS)

  it("returns isError with a Russian text for an argument that fails the decoder", async () => {
    const result = await call(main, "search_recipes", { limit: 0 })
    expect(result.isError).toBe(true)
    expect(textsOf(result)[0]).toContain("Неверные аргументы инструмента search_recipes.")
  }, CASE_MS)

  it("returns isError for an unknown tool", async () => {
    const result = await call(main, "no_such_tool", {})
    expect(result.isError).toBe(true)
    expect(textsOf(result)[0]).toContain("Неизвестный инструмент")
  }, CASE_MS)

  it("get_recipe returns the facts and the ingredient lines, and no intro or steps", async () => {
    const result = await call(main, "get_recipe", { id: 2 })
    expect(result.isError).toBeFalsy()
    const text = textsOf(result)[0] ?? ""
    expect(text).toContain("Рагу Браво")
    expect(text).toContain("куриные бёдра")
    expect(text).not.toMatch(/"(intro|steps)"/)
    const missing = await call(main, "get_recipe", { id: 999 })
    expect(missing.isError).toBe(true)
    expect(textsOf(missing)[0]).toContain("Рецепта 999 нет в каталоге.")
  }, CASE_MS)

  it("evaluate_plan accepts the base week and shopping_list returns JSON and Markdown", async () => {
    const evaluated = await call(main, "evaluate_plan", { plan: basePlan() })
    expect(evaluated.isError).toBeFalsy()
    expect(parse(textsOf(evaluated)[0])).toMatchObject({ ok: true, metrics: { buyItemCount: 14 } })

    const listed = await call(main, "shopping_list", { plan: basePlan() })
    expect(listed.isError).toBeFalsy()
    const body = parse(textsOf(listed)[0])
    expect(body).toMatchObject({ list: { weekStart: "2026-10-17" } })
    expect(textsOf(listed)[0]).toContain("# Список покупок: неделя с 2026-10-17")
  }, CASE_MS)

  it("evaluate_plan reports a plan with a missing dish as a result, and a bad plan as isError", async () => {
    const plan = { ...basePlan(), meals: basePlan().meals.slice(0, 10) }
    const evaluated = await call(main, "evaluate_plan", { plan })
    expect(evaluated.isError).toBeFalsy()
    expect(parse(textsOf(evaluated)[0])).toMatchObject({ ok: false })
    const bad = await call(main, "evaluate_plan", { plan: { weekStart: "2026-02-30" } })
    expect(bad.isError).toBe(true)
    expect(textsOf(bad)[0]).toContain("Неверные аргументы инструмента evaluate_plan.")
  }, CASE_MS)

  it("household returns the defaults when config/household.json is absent", async () => {
    const result = await call(main, "household", {})
    expect(result.isError).toBeFalsy()
    expect(parse(textsOf(result)[0])).toMatchObject({ persons: 3, days: 7 })
  }, CASE_MS)

  it("save_plan writes the JSON and the Markdown, and plan_history lists the plan", async () => {
    const before = await call(main, "plan_history", {})
    expect(parse(textsOf(before)[0])).toMatchObject({ plans: [] })

    const saved = await call(main, "save_plan", { plan: basePlan() })
    expect(saved.isError).toBeFalsy()
    expect(parse(textsOf(saved)[0])).toMatchObject({ weekStart: "2026-10-17", ok: true })
    const jsonPath = join(dataDir, "plans", "2026-10-17.json")
    const markdownPath = join(dataDir, "plans", "2026-10-17.md")
    expect(existsSync(jsonPath)).toBe(true)
    expect(readFileSync(markdownPath, "utf8")).toContain("[Суп Альфа](https://www.say7.info/cook/recipe/1-")

    const after = await call(main, "plan_history", { limit: 1 })
    const history = parse(textsOf(after)[0])
    expect(history).toMatchObject({ plans: [{ weekStart: "2026-10-17" }] })
    expect(textsOf(after)[0]).toContain("Суп Альфа")
  }, CASE_MS)

  it("serves the prompt plan_week and rejects a bad weekStart", async () => {
    const { prompts } = await main.client.listPrompts()
    expect(prompts.map((prompt) => prompt.name)).toEqual(["plan_week"])
    expect(prompts[0]?.arguments?.map((argument) => argument.name)).toEqual(["weekStart", "proteinFamily"])

    const prompt = await main.client.getPrompt({
      name: "plan_week",
      arguments: { weekStart: "2026-10-17", proteinFamily: "fish" }
    })
    const first = prompt.messages[0]?.content
    const text = first?.type === "text" ? first.text : ""
    expect(text).toContain("2026-10-17")
    expect(text).toContain("`fish`")
    expect(text).toContain("evaluate_plan")

    await expect(main.client.getPrompt({ name: "plan_week", arguments: { weekStart: "2026-13-01" } })).rejects.toThrow()
  }, CASE_MS)

  it("starts with an empty catalogue and gives a hint in the search result", async () => {
    const result = await call(empty, "search_recipes", {})
    expect(result.isError).toBeFalsy()
    expect(parse(textsOf(result)[0])).toMatchObject({ catalogueSize: 0, results: [] })
    expect(textsOf(result)[0]).toContain("Каталог пуст")
  }, CASE_MS)
})
