import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted, Stream } from "effect"
import { MODEL_NAMES, THINKING_BY_MODEL } from "../src/domain/enriched-recipe.ts"
import type { ModelName } from "../src/domain/enriched-recipe.ts"
import { buildMessageParams, classifyApiError, Llm, toBatchItem, toCompletion } from "../src/enrich/api.ts"
import type { LlmApiError, LlmRequest } from "../src/enrich/llm-types.ts"
import { ENRICHMENT_JSON_SCHEMA } from "../src/enrich/json-schema.ts"
import { SYSTEM_PROMPT } from "../src/enrich/prompt.ts"
import { walkA4 } from "./support/api-schema.ts"
import { jsonReply, startFakeAnthropic } from "./support/fake-anthropic.ts"
import type { FakeAnthropic, SeenRequest } from "./support/fake-anthropic.ts"
import { must } from "./support/enrich.ts"

/** A key that looks like a real one. No test sends it to a real server. */
const KEY = "sk-ant-api03-TESTKEY0123456789abcdefXYZ"

const llmAt = (api: FakeAnthropic) =>
  Llm.layer({
    apiKey: Redacted.make(KEY),
    baseURL: api.origin,
    maxRetries: 0,
    timeoutMs: 10_000,
  })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const recordOf = (value: unknown, what: string): Readonly<Record<string, unknown>> =>
  isRecord(value) ? value : assert.fail(`${what} is not an object`)

const arrayOf = (value: unknown, what: string): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : assert.fail(`${what} is not an array`)

const header = (request: SeenRequest, name: string): string | ReadonlyArray<string> | undefined => request.headers[name]

const REQUEST: LlmRequest = {
  model: "claude-sonnet-5-5",
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: '{"title":"Тест"}' }],
  maxTokens: 8192,
}

const message = (text: string) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 800,
    cache_read_input_tokens: 3000,
    cache_creation_input_tokens: 10,
  },
})

const batch = (origin: string, overrides: Record<string, unknown> = {}) => ({
  id: "msgbatch_test",
  type: "message_batch",
  processing_status: "in_progress",
  request_counts: {
    processing: 2,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
  },
  created_at: "2026-10-12T10:00:00Z",
  expires_at: "2026-10-13T10:00:00Z",
  ended_at: null,
  archived_at: null,
  cancel_initiated_at: null,
  results_url: null,
  ...overrides,
  ...(overrides["processing_status"] === "ended"
    ? { results_url: `${origin}/v1/messages/batches/msgbatch_test/results` }
    : {}),
})

/** What spec A3, A4 and A7 say about the parameters of one request, read from the JSON that arrived at the server. */
const assertRequestParams = (params: Readonly<Record<string, unknown>>, model: ModelName): void => {
  assert.strictEqual(params["model"], model)

  // A7: the system prompt is a list, its first block is the prompt, and the block has cache_control.
  const system = arrayOf(params["system"], "system")
  assert.deepStrictEqual(system[0], {
    type: "text",
    text: SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" },
  })

  // A3: output_config.format with the type json_schema. The deprecated output_format is absent.
  const outputConfig = recordOf(params["output_config"], "output_config")
  const format = recordOf(outputConfig["format"], "output_config.format")
  assert.strictEqual(format["type"], "json_schema")
  assert.deepStrictEqual(format["schema"], ENRICHMENT_JSON_SCHEMA)
  assert.notProperty(params, "output_format")

  // A4: the schema that arrived is inside the subset of the API.
  assert.deepStrictEqual(walkA4(format["schema"]).problems, [])

  // The system prompt comes before the messages in the body.
  const keys = Object.keys(params)
  assert.isBelow(keys.indexOf("system"), keys.indexOf("messages"))
  assert.notProperty(params, "tools")

  // The lowest thinking level of this model: Haiku "disabled", Sonnet "between_tools". No effort is sent.
  assert.deepStrictEqual(params["thinking"], THINKING_BY_MODEL[model])
  assert.notProperty(outputConfig, "effort")
}

describe("Llm.complete (Messages API)", () => {
  it.live(
    "sends output_config.format and cache_control on the system prompt, with the key in x-api-key (spec A1, A3, A7)",
    () =>
      Effect.gen(function* () {
        const api = yield* startFakeAnthropic
        api.route("POST", "/v1/messages", () => jsonReply(message('{"dish":"soup"}')))

        const completion = yield* Effect.flatMap(Llm, (llm) => llm.complete(REQUEST)).pipe(Effect.provide(llmAt(api)))

        assert.lengthOf(api.seen, 1)
        const seen = must(api.seen[0], "request")
        assert.strictEqual(seen.method, "POST")
        assert.strictEqual(seen.url, "/v1/messages")
        assert.strictEqual(header(seen, "x-api-key"), KEY)
        assert.isDefined(header(seen, "anthropic-version"))

        const body = recordOf(seen.json, "body")
        assertRequestParams(body, "claude-sonnet-5-5")
        assert.strictEqual(body["max_tokens"], 8192)
        assert.deepStrictEqual(body["messages"], [{ role: "user", content: '{"title":"Тест"}' }])

        assert.deepStrictEqual(completion, {
          text: '{"dish":"soup"}',
          stopReason: "end_turn",
          usage: {
            inputTokens: 1200,
            outputTokens: 800,
            cacheReadTokens: 3000,
            cacheCreationTokens: 10,
          },
        })
      })
  )

  for (const model of MODEL_NAMES) {
    it.live(`sends the thinking level of ${model}: ${THINKING_BY_MODEL[model].type}`, () =>
      Effect.gen(function* () {
        const api = yield* startFakeAnthropic
        api.route("POST", "/v1/messages", () => jsonReply(message("{}")))
        yield* Effect.flatMap(Llm, (llm) => llm.complete({ ...REQUEST, model })).pipe(Effect.provide(llmAt(api)))
        const body = recordOf(must(api.seen[0], "request").json, "body")
        assertRequestParams(body, model)
        assert.deepStrictEqual(body["thinking"], {
          type: model === "claude-haiku-5-5" ? "disabled" : "between_tools",
        })
      })
    )
  }

  it.live("sends the thinking level of each model in one batch", () =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      api.route("POST", "/v1/messages/batches", () => jsonReply(batch(api.origin)))
      yield* Effect.flatMap(Llm, (llm) =>
        llm.createBatch(
          MODEL_NAMES.map((model, position) => ({
            customId: `recipe-${position + 1}`,
            request: { ...REQUEST, model },
          }))
        )
      ).pipe(Effect.provide(llmAt(api)))
      const requests = arrayOf(recordOf(must(api.seen[0], "request").json, "body")["requests"], "requests")
      assert.lengthOf(requests, MODEL_NAMES.length)
      requests.forEach((item, position) => {
        const params = recordOf(recordOf(item, "request")["params"], "params")
        assertRequestParams(params, must(MODEL_NAMES[position], "model"))
      })
    })
  )

  it.live("sends the second attempt with the old answer and the error as more messages", () =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      api.route("POST", "/v1/messages", () => jsonReply(message("{}")))
      const retry: LlmRequest = {
        ...REQUEST,
        messages: [
          ...REQUEST.messages,
          { role: "assistant", content: "{}" },
          { role: "user", content: "Your answer was rejected." },
        ],
      }
      yield* Effect.flatMap(Llm, (llm) => llm.complete(retry)).pipe(Effect.provide(llmAt(api)))
      const body = recordOf(must(api.seen[0], "request").json, "body")
      assert.lengthOf(arrayOf(body["messages"], "messages"), 3)
      assertRequestParams(body, "claude-sonnet-5-5")
    })
  )

  it.live("keeps the text of several blocks and reads a missing cache count as 0", () =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      api.route("POST", "/v1/messages", () =>
        jsonReply({
          ...message(""),
          content: [
            { type: "text", text: '{"a":' },
            { type: "text", text: "1}" },
          ],
          stop_reason: "max_tokens",
          usage: { input_tokens: 10, output_tokens: 20 },
        })
      )
      const completion = yield* Effect.flatMap(Llm, (llm) => llm.complete(REQUEST)).pipe(Effect.provide(llmAt(api)))
      assert.deepStrictEqual(completion, {
        text: '{"a":1}',
        stopReason: "max_tokens",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      })
    })
  )
})

describe("Llm batch methods (Message Batches API, spec A5)", () => {
  const entries = [1, 2].map((n) => ({
    customId: `recipe-${n}`,
    request: REQUEST,
  }))

  it.live("createBatch posts every request with its custom_id and the same parameters as a single request", () =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      api.route("POST", "/v1/messages/batches", () => jsonReply(batch(api.origin)))

      const info = yield* Effect.flatMap(Llm, (llm) => llm.createBatch(entries)).pipe(Effect.provide(llmAt(api)))

      const seen = must(api.seen[0], "request")
      assert.strictEqual(seen.method, "POST")
      assert.strictEqual(seen.url, "/v1/messages/batches")
      assert.strictEqual(header(seen, "x-api-key"), KEY)
      const requests = arrayOf(recordOf(seen.json, "body")["requests"], "requests")
      assert.lengthOf(requests, 2)
      requests.forEach((item, position) => {
        const entry = recordOf(item, "request")
        assert.strictEqual(entry["custom_id"], `recipe-${position + 1}`)
        const params = recordOf(entry["params"], "params")
        assertRequestParams(params, "claude-sonnet-5-5")
        assert.strictEqual(params["max_tokens"], 8192)
      })
      assert.deepStrictEqual(info, {
        id: "msgbatch_test",
        status: "in_progress",
        processing: 2,
        succeeded: 0,
        errored: 0,
        canceled: 0,
        expired: 0,
      })
    })
  )

  it.live("getBatch retrieves the batch by its ID, to poll for the end", () =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      let polls = 0
      api.route("GET", "/v1/messages/batches/msgbatch_test", () => {
        polls += 1
        return jsonReply(
          polls < 2
            ? batch(api.origin)
            : batch(api.origin, {
                processing_status: "ended",
                request_counts: {
                  processing: 0,
                  succeeded: 1,
                  errored: 1,
                  canceled: 0,
                  expired: 0,
                },
              })
        )
      })
      const [first, second] = yield* Effect.flatMap(Llm, (llm) =>
        Effect.all([llm.getBatch("msgbatch_test"), llm.getBatch("msgbatch_test")], { concurrency: 1 })
      ).pipe(Effect.provide(llmAt(api)))
      assert.deepStrictEqual(
        api.seen.map((seen) => `${seen.method} ${seen.url}`),
        ["GET /v1/messages/batches/msgbatch_test", "GET /v1/messages/batches/msgbatch_test"]
      )
      assert.strictEqual(first?.status, "in_progress")
      assert.deepStrictEqual(second, {
        id: "msgbatch_test",
        status: "ended",
        processing: 0,
        succeeded: 1,
        errored: 1,
        canceled: 0,
        expired: 0,
      })
    })
  )

  it.live("batchResults reads the results file of the batch: succeeded, errored, canceled and expired", () =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      api.route("GET", "/v1/messages/batches/msgbatch_test", () =>
        jsonReply(batch(api.origin, { processing_status: "ended" }))
      )
      const lines = [
        {
          custom_id: "recipe-1",
          result: { type: "succeeded", message: message('{"dish":"soup"}') },
        },
        {
          custom_id: "recipe-2",
          result: {
            type: "errored",
            error: {
              type: "error",
              error: { type: "overloaded_error", message: "Overloaded" },
              request_id: null,
            },
          },
        },
        { custom_id: "recipe-3", result: { type: "canceled" } },
        { custom_id: "recipe-4", result: { type: "expired" } },
      ]
      api.route("GET", "/v1/messages/batches/msgbatch_test/results", () => ({
        headers: { "content-type": "application/x-jsonl" },
        body: lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      }))

      const items = yield* Effect.flatMap(Llm, (llm) => Stream.runCollect(llm.batchResults("msgbatch_test"))).pipe(
        Effect.provide(llmAt(api))
      )

      assert.deepStrictEqual(
        api.seen.map((seen) => `${seen.method} ${seen.url}`),
        ["GET /v1/messages/batches/msgbatch_test", "GET /v1/messages/batches/msgbatch_test/results"]
      )
      assert.isTrue(api.seen.every((seen) => header(seen, "x-api-key") === KEY))
      assert.deepStrictEqual(Array.from(items), [
        {
          customId: "recipe-1",
          outcome: {
            _tag: "Succeeded",
            completion: {
              text: '{"dish":"soup"}',
              stopReason: "end_turn",
              usage: {
                inputTokens: 1200,
                outputTokens: 800,
                cacheReadTokens: 3000,
                cacheCreationTokens: 10,
              },
            },
          },
        },
        {
          customId: "recipe-2",
          outcome: {
            _tag: "Errored",
            errorType: "overloaded_error",
            message: "Overloaded",
          },
        },
        { customId: "recipe-3", outcome: { _tag: "Canceled" } },
        { customId: "recipe-4", outcome: { _tag: "Expired" } },
      ])
    })
  )

  it.live("batchResults fails with a clear error when the batch has not ended", () =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      api.route("GET", "/v1/messages/batches/msgbatch_test", () => jsonReply(batch(api.origin)))
      const error = yield* Effect.flip(
        Effect.flatMap(Llm, (llm) => Stream.runCollect(llm.batchResults("msgbatch_test"))).pipe(
          Effect.provide(llmAt(api))
        )
      )
      assert.strictEqual(error._tag, "LlmApiError")
      assert.include(error.message, "results_url")
    })
  )
})

describe("Llm errors", () => {
  const failWith = (status: number, type: string, text: string) =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      api.route("POST", "/v1/messages", () =>
        jsonReply(
          {
            type: "error",
            error: { type, message: text },
            request_id: "req_1",
          },
          status
        )
      )
      return yield* Effect.flip(Effect.flatMap(Llm, (llm) => llm.complete(REQUEST)).pipe(Effect.provide(llmAt(api))))
    })

  const cases = [
    [401, "authentication_error", "auth"],
    [403, "permission_error", "permission"],
    [429, "rate_limit_error", "rate_limit"],
    [529, "overloaded_error", "server"],
    [500, "api_error", "server"],
    [400, "invalid_request_error", "invalid_request"],
  ] as const

  for (const [status, type, kind] of cases) {
    it.live(`${status} ${type} gives the kind ${kind}`, () =>
      Effect.gen(function* () {
        const error: LlmApiError = yield* failWith(status, type, "something went wrong")
        assert.strictEqual(error._tag, "LlmApiError")
        assert.strictEqual(error.kind, kind)
        assert.strictEqual(error.status, status)
      })
    )
  }

  it.live("hides the key when the server repeats it in the message of an error", () =>
    Effect.gen(function* () {
      const error = yield* failWith(401, "authentication_error", `invalid x-api-key: ${KEY}`)
      assert.notInclude(error.message, KEY)
      assert.notInclude(error.message, "sk-ant-")
      assert.include(error.message, "[redacted]")
    })
  )

  it.live("gives the kind protocol for an answer that is not a message", () =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      api.route("POST", "/v1/messages", () => jsonReply({ id: "msg_x", content: "not a list" }))
      const error = yield* Effect.flip(
        Effect.flatMap(Llm, (llm) => llm.complete(REQUEST)).pipe(Effect.provide(llmAt(api)))
      )
      assert.strictEqual(error.kind, "protocol")
    })
  )

  it.live("gives the kind protocol for a batch that is not valid", () =>
    Effect.gen(function* () {
      const api = yield* startFakeAnthropic
      api.route("GET", "/v1/messages/batches/msgbatch_test", () => jsonReply({ id: "msgbatch_test" }))
      const error = yield* Effect.flip(
        Effect.flatMap(Llm, (llm) => llm.getBatch("msgbatch_test")).pipe(Effect.provide(llmAt(api)))
      )
      assert.strictEqual(error.kind, "protocol")
    })
  )
})

describe("THINKING_BY_MODEL", () => {
  it("has a level for each supported model: Haiku disabled, Sonnet between_tools (Sonnet rejects disabled)", () => {
    assert.deepStrictEqual(Object.keys(THINKING_BY_MODEL).toSorted(), [...MODEL_NAMES].toSorted())
    assert.deepStrictEqual(THINKING_BY_MODEL["claude-haiku-5-5"], {
      type: "disabled",
    })
    assert.deepStrictEqual(THINKING_BY_MODEL["claude-sonnet-5-5"], {
      type: "between_tools",
    })
  })

  it("is the thinking parameter of buildMessageParams, and the request has no effort", () => {
    for (const model of MODEL_NAMES) {
      const params = buildMessageParams({ ...REQUEST, model })
      assert.deepStrictEqual(params.thinking, THINKING_BY_MODEL[model])
      assert.isUndefined(params.output_config?.effort)
    }
  })
})

describe("classifyApiError", () => {
  const base = {
    type: null,
    status: undefined,
    isTimeout: false,
    isConnection: false,
  } as const

  it("puts a timeout and a connection error first", () => {
    assert.strictEqual(
      classifyApiError({
        ...base,
        isTimeout: true,
        isConnection: true,
        status: 500,
      }),
      "timeout"
    )
    assert.strictEqual(classifyApiError({ ...base, isConnection: true }), "connection")
  })

  it("reads the type of the error body before the status", () => {
    assert.strictEqual(classifyApiError({ ...base, type: "billing_error", status: 400 }), "billing")
    assert.strictEqual(classifyApiError({ ...base, type: "not_found_error", status: 404 }), "invalid_request")
  })

  it.each([
    [401, "auth"],
    [402, "billing"],
    [403, "permission"],
    [404, "invalid_request"],
    [413, "invalid_request"],
    [429, "rate_limit"],
    [503, "server"],
    [418, "other"],
  ] as const)("reads the status %i without a type: %s", (status, kind) => {
    assert.strictEqual(classifyApiError({ ...base, status }), kind)
  })

  it("gives other for an error without type and status", () => {
    assert.strictEqual(classifyApiError(base), "other")
  })
})

describe("toCompletion and toBatchItem", () => {
  it("ignore blocks that are not text", () => {
    const completion = toCompletion({
      content: [{ type: "thinking" }, { type: "text", text: "{}" }],
      stop_reason: null,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
    })
    assert.deepStrictEqual(completion, {
      text: "{}",
      stopReason: null,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })
  })

  it("keep the custom_id of a line", () => {
    assert.deepStrictEqual(toBatchItem({ custom_id: "recipe-9", result: { type: "expired" } }), {
      customId: "recipe-9",
      outcome: { _tag: "Expired" },
    })
  })
})
