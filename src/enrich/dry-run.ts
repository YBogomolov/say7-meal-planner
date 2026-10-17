import { Option } from "effect"
import { NO_USAGE, THINKING_BY_MODEL } from "../domain/enriched-recipe.ts"
import type { ModelName, ThinkingSetting, TokenUsage } from "../domain/enriched-recipe.ts"
import type { RunMode } from "../domain/enrich-report.ts"
import type { RecipeId } from "../domain/recipe.ts"
import { buildMessageParams } from "./api.ts"
import { allLines, modelInputText } from "./input.ts"
import type { ModelInput } from "./input.ts"
import { checkApiSchema } from "./json-schema.ts"
import { MAX_OUTPUT_TOKENS_RETRY } from "./llm-types.ts"
import { chooseMode, customIdOf } from "./plan.ts"
import { costUsd, formatUsd } from "./pricing.ts"
import { requestFor } from "./request.ts"

/** The dry run turns characters into tokens at this rate. It is the rate for text in Russian. */
export const CHARS_PER_TOKEN = 3.5

/** The dry run assumes this many output tokens for each recipe. */
export const OUTPUT_TOKENS_PER_RECIPE = 1200

/** Limits of the Message Batches API: requests in one batch, and bytes of the batch. */
export const MAX_BATCH_REQUESTS = 100_000
export const MAX_BATCH_BYTES = 256 * 1024 * 1024

/** The `custom_id` of a batch request: 1 to 64 letters, digits, `_` and `-`. */
const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/

/** The `thinking` setting of each supported model, looked up by the model name of a request. */
const thinkingOfModel: ReadonlyMap<string, ThinkingSetting> = new Map(Object.entries(THINKING_BY_MODEL))

/** The parameters that go to the API for one recipe. */
export type RequestParams = ReturnType<typeof buildMessageParams>

export interface DryRunRecipe {
  readonly id: RecipeId
  readonly input: ModelInput
}

/** One request as the run would send it, with the input that made it. */
export interface BuiltRequest extends DryRunRecipe {
  readonly customId: string
  readonly params: RequestParams
}

/** Build the request of each recipe with the same code that the real run uses. */
export const buildRequests = (model: ModelName, recipes: ReadonlyArray<DryRunRecipe>): ReadonlyArray<BuiltRequest> =>
  recipes.map((recipe) => ({
    id: recipe.id,
    input: recipe.input,
    customId: customIdOf(recipe.id),
    params: buildMessageParams(requestFor(model, recipe)),
  }))

/**
 * Check each request against the rules of the spec, and the set against the limits of the Batches API.
 * Every problem is a line of text. The result is empty when all requests are valid.
 *
 * - A3: `output_config.format` has the type `json_schema`, and the request has no `output_format`.
 * - A4: the JSON Schema is inside the subset of the API. A problem of the schema is the same in every request, so it appears once.
 * - A5: the `custom_id` values are valid and unique.
 * - A6: the model is a supported model, and `thinking` is the lowest level that the model accepts (`THINKING_BY_MODEL`).
 *   The request has no `effort`.
 * - A7: the first block of the system prompt has `cache_control`.
 * - P3.3: one user message that is the canonical JSON of the input. The ingredient lines have the numbers 0 to n-1.
 */
export const validateRequests = (requests: ReadonlyArray<BuiltRequest>): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const schemaProblems = new Set<string>()
  const customIds = new Set<string>()
  const encoder = new TextEncoder()
  let bytes = 0

  for (const { id, customId, input, params } of requests) {
    const problem = (text: string): void => void problems.push(`${id}: ${text}`)

    if (!CUSTOM_ID.test(customId)) {
      problem(`custom_id "${customId}" is not 1 to 64 letters, digits, "_" or "-"`)
    }
    if (customIds.has(customId)) {
      problem(`custom_id "${customId}" is used twice`)
    }
    customIds.add(customId)

    const thinking = thinkingOfModel.get(params.model)
    if (thinking === undefined) {
      problem(`model "${params.model}" is not supported`)
    } else if (JSON.stringify(params.thinking) !== JSON.stringify(thinking)) {
      problem(`thinking must be ${JSON.stringify(thinking)} for ${params.model}; the model rejects the other levels`)
    }
    if (params.output_config?.effort !== undefined) {
      problem("the request sets output_config.effort; send no effort, so that the model default stays")
    }
    if (!Number.isInteger(params.max_tokens) || params.max_tokens < 1 || params.max_tokens > MAX_OUTPUT_TOKENS_RETRY) {
      problem(`max_tokens ${params.max_tokens} is not a whole number from 1 to ${MAX_OUTPUT_TOKENS_RETRY}`)
    }

    const [first] = Array.isArray(params.system) ? params.system : []
    if (first === undefined || first.type !== "text" || first.text.trim() === "") {
      problem("the system prompt must be a list that starts with a text block")
    } else if (first.cache_control?.type !== "ephemeral") {
      problem("the system prompt has no cache_control (spec A7)")
    }

    const format = params.output_config?.format
    if (format?.type !== "json_schema") {
      problem('output_config.format must have the type "json_schema" (spec A3)')
    } else {
      for (const violation of checkApiSchema(format.schema).violations) {
        schemaProblems.add(violation)
      }
    }
    if (Object.hasOwn(params, "output_format")) {
      problem("the request has output_format, which is deprecated; use output_config.format (spec A3)")
    }

    const [message] = params.messages
    if (params.messages.length !== 1 || message?.role !== "user" || message.content !== modelInputText(input)) {
      problem("the request must have 1 user message with the canonical JSON of the input (spec P3.3)")
    }
    const lines = allLines(input)
    if (lines.length === 0) {
      problem("the recipe has no ingredient line")
    } else if (lines.some((line, position) => line.line !== position)) {
      problem("the ingredient lines are not numbered from 0 to n-1 (spec P3.3)")
    }
    if (input.title.trim() === "" || lines.some((line) => line.text.trim() === "")) {
      problem("the title or an ingredient line is empty")
    }

    bytes += encoder.encode(JSON.stringify(params)).length
  }

  for (const violation of schemaProblems) {
    problems.push(`output schema: ${violation}`)
  }
  if (requests.length > MAX_BATCH_REQUESTS) {
    problems.push(`${requests.length} requests are more than a batch accepts (${MAX_BATCH_REQUESTS}); use --limit`)
  }
  if (bytes > MAX_BATCH_BYTES) {
    problems.push(`the requests have ${bytes} bytes; a batch accepts ${MAX_BATCH_BYTES}; use --limit`)
  }
  return problems
}

const systemCharsOf = (params: RequestParams): number =>
  typeof params.system === "string"
    ? params.system.length
    : (params.system ?? []).reduce((total, block) => total + block.text.length, 0)

const schemaCharsOf = (params: RequestParams): number => {
  const schema = params.output_config?.format?.schema
  return schema === undefined ? 0 : JSON.stringify(schema).length
}

const userCharsOf = (params: RequestParams): number =>
  params.messages.reduce(
    (total, message) =>
      total + (typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length),
    0
  )

/**
 * Characters of the input of all requests. The input of a request is the system prompt, the output schema and the user message.
 * The API adds the schema to the prompt, so it counts as input.
 */
export interface CharStats {
  readonly requests: number
  /** All input characters of all requests. */
  readonly total: number
  /** `total` divided by the number of requests. */
  readonly average: number
  /** The system prompt of one request. It is the same in all requests. */
  readonly systemEach: number
  /** The output schema of one request. It is the same in all requests. */
  readonly schemaEach: number
  /** The user message (the recipe): the shortest, the longest and the average. */
  readonly recipe: {
    readonly min: number
    readonly max: number
    readonly average: number
  }
}

export const charStats = (requests: ReadonlyArray<BuiltRequest>): CharStats => {
  const count = requests.length
  const users = requests.map((request) => userCharsOf(request.params))
  const first = requests[0]
  const systemEach = first === undefined ? 0 : systemCharsOf(first.params)
  const schemaEach = first === undefined ? 0 : schemaCharsOf(first.params)
  const total = requests.reduce(
    (sum, request, position) =>
      sum + systemCharsOf(request.params) + schemaCharsOf(request.params) + (users[position] ?? 0),
    0
  )
  const userTotal = users.reduce((sum, value) => sum + value, 0)
  return {
    requests: count,
    total,
    average: count === 0 ? 0 : total / count,
    systemEach,
    schemaEach,
    recipe: {
      min: count === 0 ? 0 : Math.min(...users),
      max: count === 0 ? 0 : Math.max(...users),
      average: count === 0 ? 0 : userTotal / count,
    },
  }
}

export interface ModelEstimate {
  readonly model: ModelName
  readonly inputTokens: number
  readonly outputTokens: number
  /** Batch mode: 50 % of the price, no cache hit. This is the upper limit. */
  readonly batchUsd: number
  readonly syncUsd: number
  /** Batch mode, and every request but the first reads the system prompt from the cache. This is the lower limit. */
  readonly batchUsdCached: number
}

/**
 * Tokens and cost of one model (spec A10).
 * Input tokens are the input characters divided by `CHARS_PER_TOKEN`. Output tokens are `OUTPUT_TOKENS_PER_RECIPE` for each request.
 */
export const estimateModel = (model: ModelName, stats: CharStats): ModelEstimate => {
  const inputTokens = Math.ceil(stats.total / CHARS_PER_TOKEN)
  const outputTokens = OUTPUT_TOKENS_PER_RECIPE * stats.requests
  const plain: TokenUsage = { ...NO_USAGE, inputTokens, outputTokens }

  const systemTokens = Math.ceil(stats.systemEach / CHARS_PER_TOKEN)
  const cached: TokenUsage =
    stats.requests === 0
      ? plain
      : {
          inputTokens: Math.max(0, inputTokens - stats.requests * systemTokens),
          outputTokens,
          cacheReadTokens: (stats.requests - 1) * systemTokens,
          cacheCreationTokens: systemTokens,
        }
  return {
    model,
    inputTokens,
    outputTokens,
    batchUsd: costUsd(plain, model, "batch"),
    syncUsd: costUsd(plain, model, "sync"),
    batchUsdCached: costUsd(cached, model, "batch"),
  }
}

export interface DryRunSummary {
  /** Parsed files that the flags select, readable or not. */
  readonly files: number
  readonly unreadable: number
  readonly outOfScope: number
  /** Recipes in scope (spec P3.1), before `--limit`. */
  readonly inScope: number
  /** Requests that a run builds: the recipes in scope after `--limit`. */
  readonly requests: number
  /** The mode that a real run uses. */
  readonly mode: RunMode
  readonly stats: CharStats
  readonly problems: ReadonlyArray<string>
  readonly estimates: ReadonlyArray<ModelEstimate>
}

/**
 * Build the requests for all recipes in scope, validate them and estimate the cost for each model.
 * The stored files do not matter: the dry run counts the work of a full run.
 */
export const summariseDryRun = (parts: {
  readonly files: number
  readonly unreadable: number
  readonly outOfScope: number
  /** All recipes in scope, in ascending order of ID. */
  readonly inScope: ReadonlyArray<DryRunRecipe>
  readonly limit: Option.Option<number>
  readonly models: ReadonlyArray<ModelName>
  readonly sync: boolean
  readonly retryFailed: boolean
}): DryRunSummary => {
  const selected = Option.match(parts.limit, {
    onNone: () => parts.inScope,
    onSome: (limit) => parts.inScope.slice(0, limit),
  })
  const built = parts.models.map((model) => ({
    model,
    requests: buildRequests(model, selected),
  }))
  const stats = charStats(built[0]?.requests ?? [])
  return {
    files: parts.files,
    unreadable: parts.unreadable,
    outOfScope: parts.outOfScope,
    inScope: parts.inScope.length,
    requests: selected.length,
    mode: chooseMode({
      count: selected.length,
      sync: parts.sync,
      retryFailed: parts.retryFailed,
    }),
    stats,
    problems: built.flatMap(({ model, requests }) =>
      validateRequests(requests).map((problem) => `${model}: ${problem}`)
    ),
    estimates: built.map(({ model, requests }) => estimateModel(model, charStats(requests))),
  }
}

/** `1234567` becomes `1 234 567`. */
const grouped = (value: number): string => Math.round(value).toLocaleString("en-US").replaceAll(",", " ")

/** Widths of the number columns of the cost table: input tokens, output tokens, batch, sync, batch+cache. */
const COLUMN_WIDTHS: ReadonlyArray<number> = [14, 15, 10, 10, 13]

/** Problems that the output lists before it says how many more there are. */
const MAX_LISTED_PROBLEMS = 10

/** The lines that `npm run enrich -- --dry-run` prints. */
export const formatDryRun = (summary: DryRunSummary): ReadonlyArray<string> => {
  const { stats } = summary
  const checked = summary.estimates.length
  const columns = (name: string, ...values: ReadonlyArray<string>): string =>
    `  ${name.padEnd(18)}${values.map((value, index) => value.padStart(COLUMN_WIDTHS[index] ?? 12)).join("")}`
  const listed = summary.problems.slice(0, MAX_LISTED_PROBLEMS).map((problem) => `  ${problem}`)
  const more = summary.problems.length - listed.length
  return [
    "dry run: no request goes to the API and no file changes",
    `parsed files: ${summary.files}, unreadable ${summary.unreadable}, out of scope ${summary.outOfScope}, in scope ${summary.inScope}`,
    `requests: ${summary.requests} (a real run uses ${summary.mode} mode)`,
    `input characters: ${grouped(stats.total)} in all, ${grouped(stats.average)} for each request on average`,
    `  each request: system prompt ${grouped(stats.systemEach)}, output schema ${grouped(stats.schemaEach)}, ` +
      `recipe ${grouped(stats.recipe.min)} to ${grouped(stats.recipe.max)} (average ${grouped(stats.recipe.average)})`,
    summary.problems.length === 0
      ? `validation: ${summary.requests} requests for ${checked} ${checked === 1 ? "model" : "models"}, no problem`
      : `validation: ${summary.problems.length} problems`,
    ...listed,
    ...(more > 0 ? [`  ... and ${more} more`] : []),
    `estimated cost in USD (${CHARS_PER_TOKEN} characters for each input token, ${OUTPUT_TOKENS_PER_RECIPE} output tokens for each recipe):`,
    columns("model", "input tokens", "output tokens", "batch", "sync", "batch+cache"),
    ...summary.estimates.map((estimate) =>
      columns(
        estimate.model,
        grouped(estimate.inputTokens),
        grouped(estimate.outputTokens),
        formatUsd(estimate.batchUsd),
        formatUsd(estimate.syncUsd),
        formatUsd(estimate.batchUsdCached)
      )
    ),
    "batch is 50 % of the sync price. batch+cache assumes that every request but the first reads the system prompt from the cache.",
  ]
}
