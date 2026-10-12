import { Anthropic, APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk"
import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { THINKING_BY_MODEL } from "../domain/enriched-recipe.ts"
import { ENRICHMENT_JSON_SCHEMA } from "./json-schema.ts"
import { LlmApiError, redactKeyLike } from "./llm-types.ts"
import type { BatchEntry, BatchInfo, BatchItem, LlmCompletion, LlmErrorKind, LlmRequest } from "./llm-types.ts"

/** The API request for one `LlmRequest` (spec A3, A4, A7). */
export const buildMessageParams = (request: LlmRequest): Anthropic.MessageCreateParamsNonStreaming => ({
  model: request.model,
  max_tokens: request.maxTokens,
  // The system prompt is first and has the cache mark (spec A7).
  system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
  messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
  // Spec A3: `output_config.format`, not the deprecated `output_format`.
  output_config: { format: { type: "json_schema", schema: ENRICHMENT_JSON_SCHEMA } },
  // The task is extraction. The lowest thinking level of the model keeps the cost low and easy to predict.
  // The level differs by model: Sonnet 5.5 rejects "disabled". No `effort` is sent, so the model default stays.
  thinking: THINKING_BY_MODEL[request.model]
})

/** The kind of failure for the fields of an SDK error. */
export const classifyApiError = (error: {
  /** `error.type` of the response body. */
  readonly type: string | null
  readonly status: number | undefined
  readonly isTimeout: boolean
  readonly isConnection: boolean
}): LlmErrorKind => {
  if (error.isTimeout) return "timeout"
  if (error.isConnection) return "connection"
  switch (error.type) {
    case "authentication_error":
      return "auth"
    case "permission_error":
      return "permission"
    case "billing_error":
      return "billing"
    case "rate_limit_error":
      return "rate_limit"
    case "overloaded_error":
    case "api_error":
    case "timeout_error":
      return "server"
    case "invalid_request_error":
    case "not_found_error":
      return "invalid_request"
  }
  switch (error.status) {
    case 401:
      return "auth"
    case 403:
      return "permission"
    case 402:
      return "billing"
    case 429:
      return "rate_limit"
    case 400:
    case 404:
    case 413:
    case 422:
      return "invalid_request"
  }
  return error.status !== undefined && error.status >= 500 ? "server" : "other"
}

/** Hide the key in a message: the exact key, and anything that looks like an Anthropic key. */
export const redactSecrets = (message: string, secrets: ReadonlyArray<string>): string =>
  redactKeyLike(
    secrets
      .filter((secret) => secret !== "")
      .reduce((text, secret) => text.split(secret).join("[redacted]"), message)
  )

const toApiError = (secrets: ReadonlyArray<string>) => (cause: unknown): LlmApiError => {
  if (cause instanceof APIError) {
    return new LlmApiError({
      kind: classifyApiError({
        type: cause.type,
        status: cause.status,
        isTimeout: cause instanceof APIConnectionTimeoutError,
        isConnection: cause instanceof APIConnectionError
      }),
      status: cause.status ?? null,
      message: redactSecrets(cause.message, secrets)
    })
  }
  return new LlmApiError({
    kind: "other",
    status: null,
    message: redactSecrets(cause instanceof Error ? cause.message : String(cause), secrets)
  })
}

const RawUsage = Schema.Struct({
  input_tokens: Schema.Natural,
  output_tokens: Schema.Natural,
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Natural)),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Natural))
})

/** The fields of a `Message` that this project reads. */
export const RawMessage = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  stop_reason: Schema.NullOr(Schema.String),
  usage: RawUsage
})

const RawBatch = Schema.Struct({
  id: Schema.NonEmptyString,
  processing_status: Schema.Literals(["in_progress", "canceling", "ended"]),
  request_counts: Schema.Struct({
    processing: Schema.Natural,
    succeeded: Schema.Natural,
    errored: Schema.Natural,
    canceled: Schema.Natural,
    expired: Schema.Natural
  })
})

/** One line of the results file of a batch. */
export const RawBatchLine = Schema.Struct({
  custom_id: Schema.String,
  result: Schema.Union([
    Schema.Struct({ type: Schema.Literal("succeeded"), message: RawMessage }),
    Schema.Struct({
      type: Schema.Literal("errored"),
      error: Schema.Struct({ error: Schema.Struct({ type: Schema.String, message: Schema.String }) })
    }),
    Schema.Struct({ type: Schema.Literal("canceled") }),
    Schema.Struct({ type: Schema.Literal("expired") })
  ])
})

export const toCompletion = (message: typeof RawMessage.Type): LlmCompletion => ({
  text: message.content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join(""),
  stopReason: message.stop_reason,
  usage: {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0
  }
})

export const toBatchItem = (line: typeof RawBatchLine.Type): BatchItem => {
  const { result } = line
  switch (result.type) {
    case "succeeded":
      return { customId: line.custom_id, outcome: { _tag: "Succeeded", completion: toCompletion(result.message) } }
    case "errored":
      return {
        customId: line.custom_id,
        outcome: { _tag: "Errored", errorType: result.error.error.type, message: result.error.error.message }
      }
    case "canceled":
      return { customId: line.custom_id, outcome: { _tag: "Canceled" } }
    case "expired":
      return { customId: line.custom_id, outcome: { _tag: "Expired" } }
  }
}

/** The Anthropic API: single requests and Message Batches. */
export class Llm extends Context.Service<Llm, {
  /** One request (sync mode). */
  readonly complete: (request: LlmRequest) => Effect.Effect<LlmCompletion, LlmApiError>
  /** Send a batch (spec A5). */
  readonly createBatch: (entries: ReadonlyArray<BatchEntry>) => Effect.Effect<BatchInfo, LlmApiError>
  readonly getBatch: (batchId: string) => Effect.Effect<BatchInfo, LlmApiError>
  /** The results of an ended batch, one item for each request, in any order. */
  readonly batchResults: (batchId: string) => Stream.Stream<BatchItem, LlmApiError>
}>()("say7/enrich/Llm") {
  static readonly layer = (config: LlmConfig): Layer.Layer<Llm> =>
    Layer.effect(Llm, Effect.sync(() => makeLlm(config)))
}

export interface LlmConfig {
  /** The key stays in `Redacted`, so that no log line can print it. */
  readonly apiKey: Redacted.Redacted<string>
  /** Tests send the requests to a fake server. */
  readonly baseURL?: string
  /** Tests give a fake `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Retries of the SDK for network errors, 429 and 5xx. Default 4. */
  readonly maxRetries?: number
  /** Time limit for one request in ms. Default 180 000. */
  readonly timeoutMs?: number
}

const makeLlm = (config: LlmConfig) => {
  const key = Redacted.value(config.apiKey)
  const fail = toApiError([key])
  const client = new Anthropic({
    apiKey: key,
    maxRetries: config.maxRetries ?? 4,
    timeout: config.timeoutMs ?? 180_000,
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch })
  })

  const protocolError = (what: string) => (error: { readonly message: string }) =>
    new LlmApiError({ kind: "protocol", status: null, message: redactSecrets(`${what}: ${error.message}`, [key]) })

  const decodeMessage = Schema.decodeUnknownEffect(RawMessage)
  const decodeBatch = Schema.decodeUnknownEffect(RawBatch)
  const decodeLine = Schema.decodeUnknownEffect(RawBatchLine)

  const toInfo = (batch: typeof RawBatch.Type): BatchInfo => ({
    id: batch.id,
    status: batch.processing_status,
    processing: batch.request_counts.processing,
    succeeded: batch.request_counts.succeeded,
    errored: batch.request_counts.errored,
    canceled: batch.request_counts.canceled,
    expired: batch.request_counts.expired
  })

  return Llm.of({
    complete: (request) =>
      Effect.tryPromise({
        try: (signal) => client.messages.create(buildMessageParams(request), { signal }),
        catch: fail
      }).pipe(
        Effect.flatMap((message) => decodeMessage(message).pipe(Effect.mapError(protocolError("Unexpected message")))),
        Effect.map(toCompletion)
      ),

    createBatch: (entries) =>
      Effect.tryPromise({
        try: (signal) =>
          client.messages.batches.create(
            { requests: entries.map((entry) => ({ custom_id: entry.customId, params: buildMessageParams(entry.request) })) },
            { signal }
          ),
        catch: fail
      }).pipe(
        Effect.flatMap((batch) => decodeBatch(batch).pipe(Effect.mapError(protocolError("Unexpected batch")))),
        Effect.map(toInfo)
      ),

    getBatch: (batchId) =>
      Effect.tryPromise({
        try: (signal) => client.messages.batches.retrieve(batchId, undefined, { signal }),
        catch: fail
      }).pipe(
        Effect.flatMap((batch) => decodeBatch(batch).pipe(Effect.mapError(protocolError("Unexpected batch")))),
        Effect.map(toInfo)
      ),

    batchResults: (batchId) =>
      Stream.unwrap(
        Effect.tryPromise({
          try: (signal) => client.messages.batches.results(batchId, undefined, { signal }),
          catch: fail
        }).pipe(
          Effect.map((lines) =>
            Stream.fromAsyncIterable(lines, fail).pipe(
              Stream.mapEffect((line) => decodeLine(line).pipe(Effect.mapError(protocolError("Unexpected result line")))),
              Stream.map(toBatchItem)
            )
          )
        )
      )
  })
}
