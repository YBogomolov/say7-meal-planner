import { assert, describe, it } from "@effect/vitest"
import { NO_USAGE } from "../src/domain/enriched-recipe.ts"
import { BATCH_FACTOR, costUsd, formatUsd, PRICES } from "../src/enrich/pricing.ts"

const MILLION = 1_000_000

describe("PRICES", () => {
  it("is the table of the spec A10 (USD per million tokens)", () => {
    assert.deepStrictEqual(PRICES["claude-sonnet-5-5"], {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheCreation: 2.5,
    })
    assert.deepStrictEqual(PRICES["claude-haiku-5-5"], {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheCreation: 0.125,
    })
  })

  it("bills a batch at 50 %", () => {
    assert.strictEqual(BATCH_FACTOR, 0.5)
  })
})

describe("costUsd", () => {
  it("is 0 for no tokens", () => {
    assert.strictEqual(costUsd(NO_USAGE, "claude-sonnet-5-5", "sync"), 0)
  })

  it.each([
    ["inputTokens", "claude-sonnet-5-5", 2],
    ["outputTokens", "claude-sonnet-5-5", 10],
    ["cacheReadTokens", "claude-sonnet-5-5", 0.1],
    ["cacheCreationTokens", "claude-sonnet-5-5", 2.5],
    ["inputTokens", "claude-haiku-5-5", 0.1],
    ["outputTokens", "claude-haiku-5-5", 0.5],
    ["cacheReadTokens", "claude-haiku-5-5", 0.01],
    ["cacheCreationTokens", "claude-haiku-5-5", 0.125],
  ] as const)("prices 1 million %s of %s at %f USD", (field, model, price) => {
    assert.closeTo(costUsd({ ...NO_USAGE, [field]: MILLION }, model, "sync"), price, 1e-9)
  })

  it("adds the 4 kinds of tokens", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
      cacheCreationTokens: 100_000,
    }
    // 2 + 5 + 0.2 + 0.25
    assert.closeTo(costUsd(usage, "claude-sonnet-5-5", "sync"), 7.45, 1e-9)
  })

  it("halves the cost in batch mode", () => {
    const usage = {
      inputTokens: 123_456,
      outputTokens: 78_910,
      cacheReadTokens: 5,
      cacheCreationTokens: 7,
    }
    for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"] as const) {
      assert.closeTo(costUsd(usage, model, "batch"), costUsd(usage, model, "sync") / 2, 1e-12)
    }
  })
})

describe("formatUsd", () => {
  it("writes 4 decimal places", () => {
    assert.strictEqual(formatUsd(0), "0.0000")
    assert.strictEqual(formatUsd(1), "1.0000")
    assert.strictEqual(formatUsd(12.3456789), "12.3457")
    assert.strictEqual(formatUsd(0.00004), "0.0000")
  })

  it("rounds a tie up, as the decimal value says (toFixed rounds 0.00105 down)", () => {
    assert.strictEqual((0.00105).toFixed(4), "0.0010")
    assert.strictEqual(formatUsd(0.00105), "0.0011")
    assert.strictEqual(formatUsd(0.00115), "0.0012")
    assert.strictEqual(formatUsd(0.00125), "0.0013")
    assert.strictEqual(formatUsd(2.00005), "2.0001")
  })

  it("rounds the cost of 3000 input and 1500 output tokens of haiku, 0.00105 USD, to 0.0011", () => {
    const usage = { ...NO_USAGE, inputTokens: 3000, outputTokens: 1500 }
    assert.strictEqual(formatUsd(costUsd(usage, "claude-haiku-5-5", "sync")), "0.0011")
  })
})
