import { Result, Schema } from "effect"
import { checkLineCoverage, checkLineRange } from "../domain/enriched-recipe.ts"
import type { Enrichment } from "../domain/enriched-recipe.ts"
import type { FailureKind } from "../domain/enrich-report.ts"
import { ENRICHMENT_CODEC } from "./json-schema.ts"
import { MAX_OUTPUT_TOKENS_RETRY } from "./llm-types.ts"
import type { LlmCompletion, LlmRequest } from "./llm-types.ts"
import { retryMessage } from "./prompt.ts"

/** The failures that come from an answer of the model (spec A9). */
export type AnswerFailureKind = Extract<FailureKind, "decode" | "max_tokens" | "refusal" | "stop_reason">

export type Verdict =
  | { readonly _tag: "Valid"; readonly enrichment: Enrichment }
  | {
      readonly _tag: "Invalid"
      readonly kind: AnswerFailureKind
      readonly message: string
    }

export type InvalidVerdict = Extract<Verdict, { readonly _tag: "Invalid" }>

const invalid = (kind: AnswerFailureKind, message: string): InvalidVerdict => ({
  _tag: "Invalid",
  kind,
  message,
})

const decodeAnswer = Schema.decodeUnknownResult(Schema.fromJsonString(ENRICHMENT_CODEC))

/**
 * Decide if an answer is usable (spec A9).
 * A `stop_reason` other than `end_turn` is a failure. Then the text must be JSON that passes the Effect Schema,
 * every `ingredients[].line` must be a line of the recipe (`lineCount` lines, from 0),
 * and every line of the recipe must have at least 1 item (spec P3.4).
 */
export const judgeCompletion = (completion: LlmCompletion, lineCount: number): Verdict => {
  switch (completion.stopReason) {
    case "end_turn":
      break
    case "max_tokens":
      return invalid(
        "max_tokens",
        `The answer stopped at the token limit after ${completion.usage.outputTokens} output tokens`
      )
    case "refusal":
      return invalid("refusal", "The model refused to answer")
    case null:
      return invalid("stop_reason", "The API sent no stop_reason")
    default:
      return invalid("stop_reason", `Unexpected stop_reason "${completion.stopReason}"`)
  }
  if (completion.text.trim() === "") {
    return invalid("decode", "The answer has no text")
  }
  const decoded = decodeAnswer(completion.text)
  if (Result.isFailure(decoded)) {
    return invalid("decode", decoded.failure.message)
  }
  const problems = [...checkLineRange(decoded.success, lineCount), ...checkLineCoverage(decoded.success, lineCount)]
  return problems.length > 0 ? invalid("decode", problems.join("\n")) : { _tag: "Valid", enrichment: decoded.success }
}

/**
 * The request for the second attempt after a failure, or `null` if a second attempt cannot help (spec A9).
 *
 * - `decode`: the old answer and the decoder error follow as 2 more messages.
 * - `max_tokens`: the same request with twice the token limit, up to `MAX_OUTPUT_TOKENS_RETRY`.
 * - `refusal`: the same request.
 * - `stop_reason`: no second attempt.
 */
export const retryRequest = (
  request: LlmRequest,
  completion: LlmCompletion,
  failure: InvalidVerdict
): LlmRequest | null => {
  switch (failure.kind) {
    case "decode":
      return completion.text.trim() === ""
        ? request
        : {
            ...request,
            messages: [
              ...request.messages,
              { role: "assistant", content: completion.text },
              { role: "user", content: retryMessage(failure.message) },
            ],
          }
    case "max_tokens": {
      const maxTokens = Math.min(request.maxTokens * 2, MAX_OUTPUT_TOKENS_RETRY)
      return maxTokens > request.maxTokens ? { ...request, maxTokens } : null
    }
    case "refusal":
      return request
    case "stop_reason":
      return null
  }
}
