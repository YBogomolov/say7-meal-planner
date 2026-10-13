import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { decodeArguments, defineTool, inputJsonSchema } from "../src/mcp/tool.ts"
import { decodePlanWeekArguments, planWeekPrompt } from "../src/mcp/prompt.ts"
import { projectRoot, resolvePaths } from "../src/mcp/paths.ts"
import { GetRecipeInput, HistoryInput, PlanInput } from "../src/mcp/tools.ts"
import { SearchQuery } from "../src/planner/search.ts"
import { basePlan } from "./support/planner.ts"

describe("inputJsonSchema", () => {
  it("makes an object schema from the search query, with the keys and the enums of the Effect schema", () => {
    const schema = inputJsonSchema(SearchQuery)
    assert.strictEqual(schema.type, "object")
    const properties = schema["properties"]
    assert.isObject(properties)
    assert.containsAllKeys(properties, ["text", "proteinFamilies", "sort", "limit"])
    assert.notProperty(schema, "required")
  })

  it("lists the required keys of a plan input", () => {
    const schema = inputJsonSchema(PlanInput)
    assert.deepStrictEqual(schema["required"], ["plan"])
  })

  it("makes an object schema from an empty struct", () => {
    assert.strictEqual(inputJsonSchema(Schema.Struct({})).type, "object")
  })
})

describe("decodeArguments", () => {
  it("decodes valid arguments, and treats missing arguments as {}", () => {
    assert.deepStrictEqual(Result.getOrUndefined(decodeArguments("search_recipes", SearchQuery, { text: "суп", limit: 5 })), {
      text: "суп",
      limit: 5
    })
    assert.deepStrictEqual(Result.getOrUndefined(decodeArguments("search_recipes", SearchQuery, undefined)), {})
  })

  it("fails with a Russian text that names the tool", () => {
    const result = decodeArguments("search_recipes", SearchQuery, { limit: 101 })
    assert.isTrue(Result.isFailure(result))
    assert.include(Result.isFailure(result) ? result.failure : "", "Неверные аргументы инструмента search_recipes.")
  })

  it("reports every problem in one pass", () => {
    const result = decodeArguments("search_recipes", SearchQuery, { limit: 0, vegetarian: "yes" })
    const text = Result.isFailure(result) ? result.failure : ""
    assert.include(text, "limit")
    assert.include(text, "vegetarian")
  })

  it("rejects a recipe ID that is not a positive integer", () => {
    assert.isTrue(Result.isFailure(decodeArguments("get_recipe", GetRecipeInput, { id: 0 })))
    assert.isTrue(Result.isFailure(decodeArguments("get_recipe", GetRecipeInput, { id: "1" })))
    assert.isTrue(Result.isSuccess(decodeArguments("get_recipe", GetRecipeInput, { id: 12 })))
  })

  it("limits the history size", () => {
    assert.isTrue(Result.isFailure(decodeArguments("plan_history", HistoryInput, { limit: 0 })))
    assert.isTrue(Result.isSuccess(decodeArguments("plan_history", HistoryInput, { limit: 4 })))
    assert.isTrue(Result.isSuccess(decodeArguments("plan_history", HistoryInput, {})))
  })

  it("accepts a plan and rejects a plan with a date that does not exist", () => {
    assert.isTrue(Result.isSuccess(decodeArguments("save_plan", PlanInput, { plan: basePlan() })))
    assert.isTrue(Result.isFailure(decodeArguments("save_plan", PlanInput, { plan: { ...basePlan(), weekStart: "2026-02-30" } })))
  })
})

describe("defineTool", () => {
  const tool = defineTool({
    name: "demo",
    description: "demo",
    input: GetRecipeInput,
    run: ({ id }) => id === 1 ? Effect.succeed(["один"]) : id === 2 ? Effect.fail({ message: "нет такого" }) : Effect.die("сбой")
  })

  it.effect("returns the texts of a successful run", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* tool.call({ id: 1 }), { texts: ["один"], isError: false })
    }))

  it.effect("turns a failure into an error result in Russian", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* tool.call({ id: 2 }), { texts: ["Ошибка инструмента demo: нет такого"], isError: true })
    }))

  it.effect("turns a defect into an error result", () =>
    Effect.gen(function*() {
      const result = yield* tool.call({ id: 3 })
      assert.isTrue(result.isError)
      assert.include(result.texts[0] ?? "", "Внутренняя ошибка инструмента demo.")
    }))

  it.effect("turns a decode failure into an error result", () =>
    Effect.gen(function*() {
      const result = yield* tool.call({ id: -1 })
      assert.isTrue(result.isError)
      assert.include(result.texts[0] ?? "", "Неверные аргументы инструмента demo.")
    }))
})

describe("prompt plan_week", () => {
  it("decodes the arguments and rejects a bad date or family", () => {
    assert.deepStrictEqual(Result.getOrUndefined(decodePlanWeekArguments({ weekStart: "2026-10-17" })), { weekStart: "2026-10-17" })
    assert.isTrue(Result.isFailure(decodePlanWeekArguments({ weekStart: "2026-02-30" })))
    assert.isTrue(Result.isFailure(decodePlanWeekArguments({ weekStart: "2026-10-17", proteinFamily: "tofu" })))
    assert.isTrue(Result.isFailure(decodePlanWeekArguments({})))
  })

  it("names the tools of the method in order", () => {
    const text = planWeekPrompt("2026-10-17", undefined)
    const order = ["`household`", "`plan_history`", "`search_recipes`", "`evaluate_plan`", "`shopping_list`", "`save_plan`"]
    const positions = order.map((name) => text.indexOf(name))
    assert.isTrue(positions.every((position) => position >= 0))
    assert.deepStrictEqual([...positions].sort((a, b) => a - b), positions)
    assert.include(text, "in Russian")
  })

  it("fixes the protein family when the argument is given", () => {
    assert.include(planWeekPrompt("2026-10-17", "fish"), "`fish`")
    assert.notInclude(planWeekPrompt("2026-10-17", undefined), "Use the protein family")
  })
})

describe("resolvePaths", () => {
  it("finds the project root from the server file, two levels above src/mcp", () => {
    assert.strictEqual(projectRoot("file:///work/recipes/src/mcp/server.ts"), "/work/recipes")
  })

  it("uses <root>/data and <root>/config by default", () => {
    const paths = resolvePaths("/work/recipes", {})
    assert.deepStrictEqual(Result.getOrUndefined(paths), { root: "/work/recipes", dataDir: "/work/recipes/data", configDir: "/work/recipes/config" })
  })

  it("lets SAY7_DATA_DIR and SAY7_CONFIG_DIR replace them, and rejects an empty value", () => {
    const paths = resolvePaths("/work/recipes", { SAY7_DATA_DIR: "/tmp/d", SAY7_CONFIG_DIR: "/tmp/c" })
    assert.deepStrictEqual(Result.getOrUndefined(paths), { root: "/work/recipes", dataDir: "/tmp/d", configDir: "/tmp/c" })
    assert.isTrue(Result.isFailure(resolvePaths("/work/recipes", { SAY7_DATA_DIR: "" })))
  })
})
