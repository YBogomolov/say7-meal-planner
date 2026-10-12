import { Schema } from "effect"
import type { ModelName, TokenUsage } from "../domain/enriched-recipe.ts"

/** Tokens that one answer may have. A recipe of 40 lines needs about 3000. */
export const MAX_OUTPUT_TOKENS = 8192

/** The limit for the second attempt after `max_tokens`. Larger values need a streaming request. */
export const MAX_OUTPUT_TOKENS_RETRY = 16_000

export interface LlmMessage {
  readonly role: "user" | "assistant"
  readonly content: string
}

/** One request, without the details of the SDK. */
export interface LlmRequest {
  readonly model: ModelName
  /** The system prompt. The request marks it for caching (spec A7). */
  readonly system: string
  readonly messages: ReadonlyArray<LlmMessage>
  readonly maxTokens: number
}

/** The answer to one request, without the details of the SDK. */
export interface LlmCompletion {
  /** The text blocks of the answer, joined. */
  readonly text: string
  /** `stop_reason` of the API, for example `end_turn`, `max_tokens` or `refusal`. `null` if the API sent none. */
  readonly stopReason: string | null
  readonly usage: TokenUsage
}

export interface BatchEntry {
  /** Matches a result to its request. The API accepts 1 to 64 letters, digits, `_` and `-`. */
  readonly customId: string
  readonly request: LlmRequest
}

export type BatchStatus = "in_progress" | "canceling" | "ended"

export interface BatchInfo {
  readonly id: string
  readonly status: BatchStatus
  readonly processing: number
  readonly succeeded: number
  readonly errored: number
  readonly canceled: number
  readonly expired: number
}

export type BatchOutcome =
  | { readonly _tag: "Succeeded"; readonly completion: LlmCompletion }
  | { readonly _tag: "Errored"; readonly errorType: string; readonly message: string }
  | { readonly _tag: "Canceled" }
  | { readonly _tag: "Expired" }

export interface BatchItem {
  readonly customId: string
  readonly outcome: BatchOutcome
}

export const LlmErrorKind = Schema.Literals([
  "auth",
  "permission",
  "billing",
  "rate_limit",
  "server",
  "connection",
  "timeout",
  "invalid_request",
  "protocol",
  "other"
])
export type LlmErrorKind = typeof LlmErrorKind.Type

/** A request to the API failed. The SDK has already retried what it can retry. */
export class LlmApiError extends Schema.TaggedError<LlmApiError>()("LlmApiError", {
  kind: LlmErrorKind,
  status: Schema.NullOr(Schema.Int),
  message: Schema.String
}) {}

/**
 * Hide anything that looks like an Anthropic key (`sk-ant-...`).
 * Text that goes to the console or to `_report.json` passes through this function.
 */
export const redactKeyLike = (text: string): string => text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")

/**
 * A failure that stops the whole run, because every later request fails in the same way:
 * a wrong key, a key without permission, or no credit.
 */
export const isFatal = (error: LlmApiError): boolean =>
  error.kind === "auth" || error.kind === "permission" || error.kind === "billing"
