import { assert, describe, it } from "@effect/vitest"
import { judgeCompletion, retryRequest } from "../src/enrich/decode.ts"
import type { InvalidVerdict } from "../src/enrich/decode.ts"
import { MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_RETRY } from "../src/enrich/llm-types.ts"
import type { LlmRequest } from "../src/enrich/llm-types.ts"
import { retryMessage } from "../src/enrich/prompt.ts"
import { enrichmentFor } from "./support/enrich.ts"
import { answer, rawAnswer, USAGE } from "./support/fake-llm.ts"

const invalid = (verdict: ReturnType<typeof judgeCompletion>): InvalidVerdict => {
  if (verdict._tag !== "Invalid") {
    return assert.fail("expected an invalid verdict")
  }
  return verdict
}

describe("judgeCompletion", () => {
  it("accepts a valid answer", () => {
    const verdict = judgeCompletion(answer(enrichmentFor(3)), 3)
    assert.deepStrictEqual(verdict, { _tag: "Valid", enrichment: enrichmentFor(3) })
  })

  it("fails with the kind max_tokens", () => {
    const verdict = invalid(judgeCompletion(rawAnswer('{"ingredients":[', "max_tokens"), 3))
    assert.strictEqual(verdict.kind, "max_tokens")
    assert.include(verdict.message, "800 output tokens")
  })

  it("fails with the kind refusal, even if the text is valid", () => {
    const refused = { ...answer(enrichmentFor(3)), stopReason: "refusal" }
    assert.strictEqual(invalid(judgeCompletion(refused, 3)).kind, "refusal")
  })

  it("fails with the kind stop_reason when the API sends no reason or an unknown one", () => {
    const none = invalid(judgeCompletion({ ...answer(enrichmentFor(3)), stopReason: null }, 3))
    assert.strictEqual(none.kind, "stop_reason")
    const other = invalid(judgeCompletion({ ...answer(enrichmentFor(3)), stopReason: "pause_turn" }, 3))
    assert.strictEqual(other.kind, "stop_reason")
    assert.include(other.message, "pause_turn")
  })

  it("fails with the kind decode for an empty text", () => {
    assert.strictEqual(invalid(judgeCompletion(rawAnswer("  \n"), 3)).kind, "decode")
  })

  it("fails with the kind decode for text that is not JSON", () => {
    assert.strictEqual(invalid(judgeCompletion(rawAnswer("Here is the answer: {}"), 3)).kind, "decode")
  })

  it("fails with the kind decode, and names the field, for a value outside its range", () => {
    const verdict = invalid(judgeCompletion(rawAnswer(JSON.stringify({ ...enrichmentFor(3), heat: 7 })), 3))
    assert.strictEqual(verdict.kind, "decode")
    assert.include(verdict.message, "heat")
  })

  it("fails with the kind decode for a missing field", () => {
    const { reheats: _, ...rest } = enrichmentFor(3)
    const verdict = invalid(judgeCompletion(rawAnswer(JSON.stringify(rest)), 3))
    assert.strictEqual(verdict.kind, "decode")
    assert.include(verdict.message, "reheats")
  })

  it("fails with the kind decode for a line number outside the recipe", () => {
    const verdict = invalid(judgeCompletion(answer(enrichmentFor(5)), 4))
    assert.strictEqual(verdict.kind, "decode")
    assert.include(verdict.message, "ingredients[4].line is 4")
  })

  it("fails with the kind decode, and names the lines, when a line of the recipe has no item (spec P3.4)", () => {
    const verdict = invalid(judgeCompletion(answer(enrichmentFor(2)), 4))
    assert.strictEqual(verdict.kind, "decode")
    assert.include(verdict.message, "no item for the lines 2, 3")
  })

  it("reports a line out of range and a line without an item together", () => {
    const base = enrichmentFor(3)
    const skipped = { ...base, ingredients: base.ingredients.filter((item) => item.line !== 1) }
    const verdict = invalid(judgeCompletion(answer(skipped), 2))
    assert.include(verdict.message, "ingredients[1].line is 2")
    assert.include(verdict.message, "no item for the lines 1")
  })
})

describe("retryRequest", () => {
  const request: LlmRequest = {
    model: "claude-haiku-5-5",
    system: "system",
    messages: [{ role: "user", content: "recipe" }],
    maxTokens: MAX_OUTPUT_TOKENS
  }
  const failure = (kind: InvalidVerdict["kind"], message = "problem"): InvalidVerdict => ({ _tag: "Invalid", kind, message })

  it("appends the old answer and the decoder error after a decode failure (spec A9)", () => {
    const next = retryRequest(request, rawAnswer("{bad"), failure("decode", "heat: out of range"))
    assert.deepStrictEqual(next?.messages, [
      { role: "user", content: "recipe" },
      { role: "assistant", content: "{bad" },
      { role: "user", content: retryMessage("heat: out of range") }
    ])
    assert.strictEqual(next?.maxTokens, request.maxTokens)
    assert.strictEqual(next?.system, request.system)
  })

  it("repeats the request when the decode failure had no text", () => {
    assert.deepStrictEqual(retryRequest(request, rawAnswer(""), failure("decode")), request)
  })

  it("doubles the token limit after max_tokens, up to the cap", () => {
    assert.strictEqual(retryRequest(request, rawAnswer("{", "max_tokens"), failure("max_tokens"))?.maxTokens, 16_000)
    assert.strictEqual(MAX_OUTPUT_TOKENS_RETRY, 16_000)
    const big = { ...request, maxTokens: 10_000 }
    assert.strictEqual(retryRequest(big, rawAnswer("{", "max_tokens"), failure("max_tokens"))?.maxTokens, MAX_OUTPUT_TOKENS_RETRY)
  })

  it("makes no second attempt when the token limit is at the cap", () => {
    const capped = { ...request, maxTokens: MAX_OUTPUT_TOKENS_RETRY }
    assert.isNull(retryRequest(capped, rawAnswer("{", "max_tokens"), failure("max_tokens")))
  })

  it("repeats the same request after a refusal", () => {
    assert.deepStrictEqual(retryRequest(request, rawAnswer("", "refusal", USAGE), failure("refusal")), request)
  })

  it("makes no second attempt after an unexpected stop_reason", () => {
    assert.isNull(retryRequest(request, rawAnswer("{}", "pause_turn"), failure("stop_reason")))
  })
})
