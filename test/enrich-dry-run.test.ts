import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import {
  buildRequests,
  charStats,
  CHARS_PER_TOKEN,
  estimateModel,
  formatDryRun,
  MAX_BATCH_REQUESTS,
  OUTPUT_TOKENS_PER_RECIPE,
  summariseDryRun,
  validateRequests
} from "../src/enrich/dry-run.ts"
import type { BuiltRequest, CharStats, DryRunRecipe, DryRunSummary } from "../src/enrich/dry-run.ts"
import { buildModelInput, modelInputText } from "../src/enrich/input.ts"
import { ENRICHMENT_JSON_SCHEMA } from "../src/enrich/json-schema.ts"
import { SYSTEM_PROMPT } from "../src/enrich/prompt.ts"
import { must, parsedRecipe } from "./support/enrich.ts"

const recipe = (n: number, lines?: ReadonlyArray<string>): DryRunRecipe => {
  const parsed = parsedRecipe(n, lines === undefined ? {} : { lines })
  return { id: parsed.id, input: buildModelInput(parsed) }
}

const recipes = (count: number): ReadonlyArray<DryRunRecipe> => Array.from({ length: count }, (_, i) => recipe(i + 1))

const built = (count = 3): ReadonlyArray<BuiltRequest> => buildRequests("claude-haiku-5-5", recipes(count))

/** The first request with changes. */
const changed = (changes: Partial<BuiltRequest>): ReadonlyArray<BuiltRequest> => [{ ...must(built(1)[0], "request"), ...changes }]

describe("buildRequests", () => {
  it("builds the parameters of the real run for each recipe", () => {
    const requests = built(2)
    assert.deepStrictEqual(requests.map((request) => request.customId), ["recipe-1", "recipe-2"])
    const first = must(requests[0], "first request")
    assert.strictEqual(first.params.model, "claude-haiku-5-5")
    const [block] = Array.isArray(first.params.system) ? first.params.system : []
    assert.strictEqual(block?.text, SYSTEM_PROMPT)
    assert.deepStrictEqual(first.params.messages, [{ role: "user", content: modelInputText(first.input) }])
  })
})

describe("validateRequests", () => {
  it("accepts the requests of the real run", () => {
    assert.deepStrictEqual(validateRequests(built(5)), [])
    assert.deepStrictEqual(validateRequests(buildRequests("claude-sonnet-5-5", recipes(2))), [])
    assert.deepStrictEqual(validateRequests([]), [])
  })

  it("rejects a system prompt without cache_control (spec A7)", () => {
    const request = must(built(1)[0], "request")
    const problems = validateRequests(changed({
      params: { ...request.params, system: [{ type: "text", text: SYSTEM_PROMPT }] }
    }))
    assert.deepStrictEqual(problems, ["1: the system prompt has no cache_control (spec A7)"])
  })

  it("rejects a system prompt that is a plain string, because a string cannot carry cache_control", () => {
    const request = must(built(1)[0], "request")
    const problems = validateRequests(changed({ params: { ...request.params, system: SYSTEM_PROMPT } }))
    assert.deepStrictEqual(problems, ["1: the system prompt must be a list that starts with a text block"])
  })

  it("rejects a request without output_config.format of the type json_schema (spec A3)", () => {
    const request = must(built(1)[0], "request")
    const { output_config: _, ...withoutFormat } = request.params
    assert.isTrue(validateRequests(changed({ params: withoutFormat })).some((problem) => problem.includes("json_schema")))
  })

  it("rejects the deprecated output_format (spec A3)", () => {
    const request = must(built(1)[0], "request")
    const params = Object.assign({}, request.params, { output_format: { type: "json_schema", schema: {} } })
    const problems = validateRequests(changed({ params }))
    assert.deepStrictEqual(problems, [
      "1: the request has output_format, which is deprecated; use output_config.format (spec A3)"
    ])
  })

  it("rejects a schema outside the subset of the API (spec A4) once, not once for each request", () => {
    const [first, second] = built(2)
    const wrong = (item: BuiltRequest | undefined): BuiltRequest => {
      const request = must(item, "request")
      return {
        ...request,
        params: {
          ...request.params,
          output_config: {
            format: {
              type: "json_schema",
              schema: { ...ENRICHMENT_JSON_SCHEMA, additionalProperties: true }
            }
          }
        }
      }
    }
    const problems = validateRequests([wrong(first), wrong(second)])
    assert.deepStrictEqual(problems, ['output schema: $: an object needs "additionalProperties": false'])
  })

  it("rejects an enum together with a type array (the old unit schema, HTTP 400 at the API) once", () => {
    const [first, second] = built(2)
    const oldUnit = { type: ["string", "null"], enum: ["g", "ml", "pcs", "tbsp", "tsp", "pinch", "bunch", "clove", "slice", "pack", null] }
    const wrong = (item: BuiltRequest | undefined): BuiltRequest => {
      const request = must(item, "request")
      const ingredients = ENRICHMENT_JSON_SCHEMA.properties.ingredients
      const schema = {
        ...ENRICHMENT_JSON_SCHEMA,
        properties: {
          ...ENRICHMENT_JSON_SCHEMA.properties,
          ingredients: {
            ...ingredients,
            items: { ...ingredients.items, properties: { ...ingredients.items.properties, unit: oldUnit } }
          }
        }
      }
      return { ...request, params: { ...request.params, output_config: { format: { type: "json_schema", schema } } } }
    }
    const problems = validateRequests([wrong(first), wrong(second)])
    assert.lengthOf(problems, 1)
    assert.match(
      must(problems[0], "problem"),
      /^output schema: \$\.ingredients\[\]\.unit: "enum" must not be combined with a type array/
    )
    const summary = { ...summariseDryRun({
      files: 1, unreadable: 0, outOfScope: 0, inScope: recipes(1), limit: Option.none(),
      models: ["claude-haiku-5-5"], sync: true, retryFailed: false
    }), problems }
    const text = formatDryRun(summary).join("\n")
    assert.include(text, "validation: 1 problems")
    assert.notInclude(text, "no problem")
  })

  it("rejects a bad or repeated custom_id (spec A5)", () => {
    const request = must(built(1)[0], "request")
    assert.isTrue(validateRequests(changed({ customId: "recipe 1" })).some((problem) => problem.includes("custom_id")))
    assert.isTrue(validateRequests(changed({ customId: "x".repeat(65) })).some((problem) => problem.includes("custom_id")))
    assert.deepStrictEqual(validateRequests([request, request]), ['1: custom_id "recipe-1" is used twice'])
  })

  it("accepts the thinking level of each model: Haiku disabled, Sonnet between_tools", () => {
    const [haiku] = buildRequests("claude-haiku-5-5", recipes(1))
    const [sonnet] = buildRequests("claude-sonnet-5-5", recipes(1))
    assert.deepStrictEqual(must(haiku, "haiku").params.thinking, { type: "disabled" })
    assert.deepStrictEqual(must(sonnet, "sonnet").params.thinking, { type: "between_tools" })
    assert.deepStrictEqual(validateRequests([must(haiku, "haiku"), { ...must(sonnet, "sonnet"), customId: "recipe-2" }]), [])
  })

  it("rejects disabled for Sonnet (HTTP 400 at the API) and between_tools for Haiku", () => {
    const sonnet = must(buildRequests("claude-sonnet-5-5", recipes(1))[0], "sonnet")
    assert.deepStrictEqual(validateRequests([{ ...sonnet, params: { ...sonnet.params, thinking: { type: "disabled" } } }]), [
      '1: thinking must be {"type":"between_tools"} for claude-sonnet-5-5; the model rejects the other levels'
    ])
    const haiku = must(built(1)[0], "haiku")
    assert.deepStrictEqual(validateRequests([{ ...haiku, params: { ...haiku.params, thinking: { type: "between_tools" } } }]), [
      '1: thinking must be {"type":"disabled"} for claude-haiku-5-5; the model rejects the other levels'
    ])
  })

  it("rejects a request without thinking, with a thinking budget, or with an effort", () => {
    const request = must(built(1)[0], "request")
    const { thinking: _, ...withoutThinking } = request.params
    assert.lengthOf(validateRequests(changed({ params: withoutThinking })), 1)
    assert.lengthOf(
      validateRequests(changed({ params: { ...request.params, thinking: { type: "enabled", budget_tokens: 2000 } } })),
      1
    )
    const withEffort = validateRequests(changed({
      params: { ...request.params, output_config: { ...request.params.output_config, effort: "low" } }
    }))
    assert.deepStrictEqual(withEffort, ["1: the request sets output_config.effort; send no effort, so that the model default stays"])
  })

  it("rejects a model that is not supported (spec A6) and a bad max_tokens", () => {
    const request = must(built(1)[0], "request")
    assert.deepStrictEqual(validateRequests(changed({ params: { ...request.params, model: "claude-opus-5" } })), [
      '1: model "claude-opus-5" is not supported'
    ])
    for (const maxTokens of [0, 1.5, 16_001]) {
      assert.isTrue(
        validateRequests(changed({ params: { ...request.params, max_tokens: maxTokens } })).some((problem) =>
          problem.includes("max_tokens")
        ),
        String(maxTokens)
      )
    }
  })

  it("rejects a user message that is not the canonical JSON of the input (spec P3.3)", () => {
    const request = must(built(1)[0], "request")
    const wrongText = validateRequests(changed({
      params: { ...request.params, messages: [{ role: "user", content: "title" }] }
    }))
    assert.strictEqual(wrongText.length, 1)
    assert.include(must(wrongText[0], "problem"), "canonical JSON")
    const twoMessages = validateRequests(changed({
      params: { ...request.params, messages: [...request.params.messages, { role: "assistant", content: "x" }] }
    }))
    assert.strictEqual(twoMessages.length, 1)
  })

  it("rejects ingredient lines that are not numbered from 0, and a recipe without a line (spec P3.3)", () => {
    const input = must(built(1)[0], "request").input
    const [group] = input.ingredientGroups
    const renumbered = {
      ...input,
      ingredientGroups: [{ title: null, lines: (group?.lines ?? []).map((line) => ({ ...line, line: line.line + 1 })) }]
    }
    assert.isTrue(
      validateRequests(changed({ input: renumbered })).some((problem) => problem.includes("not numbered from 0 to n-1"))
    )
    const empty = { ...input, ingredientGroups: [] }
    assert.isTrue(validateRequests(changed({ input: empty })).some((problem) => problem.includes("no ingredient line")))
  })

  it("rejects more requests than a batch accepts", () => {
    const request = must(built(1)[0], "request")
    const many = Array.from({ length: MAX_BATCH_REQUESTS + 1 }, (_, i) => ({ ...request, customId: `recipe-${i + 1}` }))
    const problems = validateRequests(many)
    assert.isTrue(problems.some((problem) => problem.includes(`${MAX_BATCH_REQUESTS + 1} requests are more than a batch accepts`)))
  })
})

describe("charStats", () => {
  it("counts the system prompt, the output schema and the user message of each request", () => {
    const requests = built(3)
    const stats = charStats(requests)
    const users = requests.map((request) => modelInputText(request.input).length)
    const schema = JSON.stringify(ENRICHMENT_JSON_SCHEMA).length
    assert.strictEqual(stats.requests, 3)
    assert.strictEqual(stats.systemEach, SYSTEM_PROMPT.length)
    assert.strictEqual(stats.schemaEach, schema)
    assert.strictEqual(stats.total, 3 * (SYSTEM_PROMPT.length + schema) + users.reduce((sum, value) => sum + value, 0))
    assert.strictEqual(stats.average, stats.total / 3)
    assert.deepStrictEqual(
      [stats.recipe.min, stats.recipe.max],
      [Math.min(...users), Math.max(...users)]
    )
  })

  it("uses the longest and the shortest recipe for min and max", () => {
    const short = recipe(1, ["соль"])
    const long = recipe(2, Array.from({ length: 15 }, (_, i) => `${i + 1} г муки номер ${i}`))
    const stats = charStats(buildRequests("claude-haiku-5-5", [short, long]))
    assert.isBelow(stats.recipe.min, stats.recipe.max)
    assert.strictEqual(stats.recipe.min, modelInputText(short.input).length)
    assert.strictEqual(stats.recipe.max, modelInputText(long.input).length)
  })

  it("gives zeros for no request", () => {
    assert.deepStrictEqual(charStats([]), {
      requests: 0,
      total: 0,
      average: 0,
      systemEach: 0,
      schemaEach: 0,
      recipe: { min: 0, max: 0, average: 0 }
    })
  })
})

describe("estimateModel", () => {
  const stats: CharStats = {
    requests: 2,
    total: 7000,
    average: 3500,
    systemEach: 1750,
    schemaEach: 0,
    recipe: { min: 0, max: 0, average: 0 }
  }

  it("uses the constants of the task", () => {
    assert.strictEqual(CHARS_PER_TOKEN, 3.5)
    assert.strictEqual(OUTPUT_TOKENS_PER_RECIPE, 1200)
  })

  it("turns characters into tokens at 3.5 characters for each token, and adds 1200 output tokens for each request", () => {
    const estimate = estimateModel("claude-haiku-5-5", stats)
    assert.strictEqual(estimate.inputTokens, 2000)
    assert.strictEqual(estimate.outputTokens, 2400)
  })

  it("prices the tokens with the table of spec A10, half the price in batch mode", () => {
    const haiku = estimateModel("claude-haiku-5-5", stats)
    // 2000 input at 0.10 and 2400 output at 0.50 per million tokens
    assert.closeTo(haiku.syncUsd, 0.0014, 1e-12)
    assert.closeTo(haiku.batchUsd, 0.0007, 1e-12)
    const sonnet = estimateModel("claude-sonnet-5-5", stats)
    // 2000 input at 2 and 2400 output at 10 per million tokens
    assert.closeTo(sonnet.syncUsd, 0.028, 1e-12)
    assert.closeTo(sonnet.batchUsd, 0.014, 1e-12)
  })

  it("prices the system prompt as a cache write once and as cache reads for the other requests", () => {
    const { batchUsdCached } = estimateModel("claude-haiku-5-5", stats)
    // system prompt 500 tokens. input 2000 - 2 * 500, cache read 500, cache write 500, output 2400.
    const expected = (1000 * 0.1 + 2400 * 0.5 + 500 * 0.01 + 500 * 0.125) / 1_000_000 / 2
    assert.closeTo(batchUsdCached, expected, 1e-12)
  })

  it("is 0 for no request", () => {
    const empty = estimateModel("claude-sonnet-5-5", charStats([]))
    assert.deepStrictEqual(
      [empty.inputTokens, empty.outputTokens, empty.syncUsd, empty.batchUsd, empty.batchUsdCached],
      [0, 0, 0, 0, 0]
    )
  })
})

describe("summariseDryRun", () => {
  const summary = (overrides: Partial<Parameters<typeof summariseDryRun>[0]> = {}): DryRunSummary =>
    summariseDryRun({
      files: 10,
      unreadable: 1,
      outOfScope: 4,
      inScope: recipes(5),
      limit: Option.none(),
      models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
      sync: false,
      retryFailed: false,
      ...overrides
    })

  it("counts the files, the recipes in scope and the requests", () => {
    const result = summary()
    assert.deepStrictEqual(
      [result.files, result.unreadable, result.outOfScope, result.inScope, result.requests],
      [10, 1, 4, 5, 5]
    )
    assert.deepStrictEqual(result.problems, [])
  })

  it("applies --limit to the requests only", () => {
    const result = summary({ limit: Option.some(2) })
    assert.deepStrictEqual([result.inScope, result.requests, result.stats.requests], [5, 2, 2])
  })

  it("has one estimate for each model, and sonnet costs 20 times as much as haiku", () => {
    const { estimates } = summary()
    assert.deepStrictEqual(estimates.map((estimate) => estimate.model), ["claude-haiku-5-5", "claude-sonnet-5-5"])
    const [haiku, sonnet] = estimates
    assert.closeTo(must(sonnet, "sonnet").batchUsd / must(haiku, "haiku").batchUsd, 20, 1e-9)
    assert.strictEqual(must(haiku, "haiku").inputTokens, must(sonnet, "sonnet").inputTokens)
  })

  it("uses batch mode for more than 20 requests and sync mode for fewer, or with --sync or --retry-failed", () => {
    assert.strictEqual(summary().mode, "sync")
    assert.strictEqual(summary({ inScope: recipes(21) }).mode, "batch")
    assert.strictEqual(summary({ inScope: recipes(21), sync: true }).mode, "sync")
    assert.strictEqual(summary({ inScope: recipes(21), retryFailed: true }).mode, "sync")
  })

  it("has no request and no cost for no recipe in scope", () => {
    const result = summary({ inScope: [] })
    assert.strictEqual(result.requests, 0)
    assert.isTrue(result.estimates.every((estimate) => estimate.batchUsd === 0))
  })
})

describe("formatDryRun", () => {
  const lines = formatDryRun(summariseDryRun({
    files: 1578,
    unreadable: 0,
    outOfScope: 502,
    inScope: recipes(30),
    limit: Option.none(),
    models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
    sync: false,
    retryFailed: false
  }))
  const text = lines.join("\n")

  it("starts by saying that nothing is sent", () => {
    assert.strictEqual(lines[0], "dry run: no request goes to the API and no file changes")
  })

  it("prints the recipes, the requests, the mode, the input characters and the validation", () => {
    assert.include(text, "parsed files: 1578, unreadable 0, out of scope 502, in scope 30")
    assert.include(text, "requests: 30 (a real run uses batch mode)")
    assert.match(text, /input characters: [\d ]+ in all, [\d ]+ for each request on average/)
    assert.match(text, /each request: system prompt [\d ]+, output schema [\d ]+, recipe [\d ]+ to [\d ]+ \(average [\d ]+\)/)
    assert.include(text, "validation: 30 requests for 2 models, no problem")
  })

  it("prints a row of the cost table for each model, with the batch cost in USD with 4 decimal places", () => {
    assert.include(text, "3.5 characters for each input token, 1200 output tokens for each recipe")
    const rows = lines.filter((line) => /^\s+claude-(haiku|sonnet)-5-5\s/.test(line))
    assert.lengthOf(rows, 2)
    for (const row of rows) {
      assert.match(row, /\d\.\d{4}\s+\d+\.\d{4}\s+\d+\.\d{4}$/)
    }
  })

  it("lists the first 10 problems and says how many more there are", () => {
    const base = summariseDryRun({
      files: 1,
      unreadable: 0,
      outOfScope: 0,
      inScope: recipes(1),
      limit: Option.none(),
      models: ["claude-haiku-5-5"],
      sync: true,
      retryFailed: false
    })
    const problems = Array.from({ length: 12 }, (_, i) => `problem ${i + 1}`)
    const output = formatDryRun({ ...base, problems })
    assert.include(output, "validation: 12 problems")
    assert.include(output, "  problem 10")
    assert.notInclude(output, "  problem 11")
    assert.include(output, "  ... and 2 more")
  })
})
