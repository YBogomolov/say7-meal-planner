import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { EnrichReportJson } from "../src/domain/enrich-report.ts"
import type { EnrichFailure } from "../src/domain/enrich-report.ts"
import { NO_USAGE } from "../src/domain/enriched-recipe.ts"
import { costUsd, PRICES } from "../src/enrich/pricing.ts"
import { buildReport, formatTotals, formatUsage } from "../src/enrich/report.ts"
import type { RecipeOutcome, ReportParts } from "../src/enrich/report.ts"
import { id } from "./support/enrich.ts"

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheCreationTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
})

const stored = (n: number, tokens = usage(1000, 500)): RecipeOutcome => ({
  _tag: "Stored",
  id: id(n),
  usage: tokens,
})
const failed = (n: number, kind: EnrichFailure["kind"], tokens = usage(1000, 500)): RecipeOutcome => ({
  _tag: "Failed",
  id: id(n),
  kind,
  message: `${kind} problem`,
  usage: tokens,
})

const parts = (overrides: Partial<ReportParts> = {}): ReportParts => ({
  generatedAt: "2026-10-12T15:00:00.000Z",
  model: "claude-haiku-5-5",
  promptVersion: 1,
  mode: "sync",
  retryFailed: false,
  batchId: null,
  outOfScope: 2,
  cached: 1,
  deferred: 3,
  unreadable: [{ id: id(9), kind: "unreadable", message: "bad file" }],
  outcomes: [stored(1), failed(4, "decode"), stored(2)],
  ...overrides,
})

describe("buildReport", () => {
  const report = buildReport(parts())

  it("counts the recipes", () => {
    assert.deepStrictEqual(report.totals, {
      selected: 7,
      outOfScope: 2,
      unreadable: 1,
      cached: 1,
      deferred: 3,
      processed: 3,
      succeeded: 2,
      failed: 2,
    })
  })

  it("lists the failures in ascending order of ID, the unreadable files included", () => {
    assert.deepStrictEqual(report.failures, [
      { id: id(4), kind: "decode", message: "decode problem" },
      { id: id(9), kind: "unreadable", message: "bad file" },
    ])
  })

  it("adds the tokens of all answers, also those of failed recipes", () => {
    assert.deepStrictEqual(report.usage, usage(3000, 1500))
  })

  it("estimates the cost with the price table of the model (spec A10)", () => {
    assert.strictEqual(report.cost.currency, "USD")
    assert.strictEqual(report.cost.model, "claude-haiku-5-5")
    assert.deepStrictEqual(report.cost.pricePerMillionTokens, PRICES["claude-haiku-5-5"])
    assert.strictEqual(report.cost.batchFactor, 1)
    // 3000 input at 0.10 and 1500 output at 0.50 per million tokens
    assert.closeTo(report.cost.estimatedUsd, 0.00105, 1e-9)
  })

  it("takes half of the price in batch mode", () => {
    const batch = buildReport(parts({ mode: "batch", batchId: "msgbatch_1" }))
    assert.strictEqual(batch.mode, "batch")
    assert.strictEqual(batch.batchId, "msgbatch_1")
    assert.strictEqual(batch.cost.batchFactor, 0.5)
    assert.closeTo(batch.cost.estimatedUsd, report.cost.estimatedUsd / 2, 1e-9)
  })

  it("uses the price of the model of the run", () => {
    const sonnet = buildReport(parts({ model: "claude-sonnet-5-5" }))
    assert.closeTo(sonnet.cost.estimatedUsd, costUsd(usage(3000, 1500), "claude-sonnet-5-5", "sync"), 1e-9)
    assert.closeTo(sonnet.cost.estimatedUsd / report.cost.estimatedUsd, 20, 1e-6)
  })

  it("prices the cache tokens", () => {
    const cached = buildReport(parts({ outcomes: [stored(1, usage(0, 0, 1_000_000, 1_000_000))] }))
    // 1 million cache read at 0.01 and 1 million cache write at 0.125
    assert.closeTo(cached.cost.estimatedUsd, 0.135, 1e-9)
  })

  it("handles a run without work", () => {
    const empty = buildReport(parts({ outcomes: [], unreadable: [], deferred: 0, cached: 4 }))
    assert.deepStrictEqual(empty.totals, {
      selected: 4,
      outOfScope: 2,
      unreadable: 0,
      cached: 4,
      deferred: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
    })
    assert.deepStrictEqual(empty.usage, NO_USAGE)
    assert.strictEqual(empty.cost.estimatedUsd, 0)
  })

  it("keeps the flag --retry-failed", () => {
    assert.isTrue(buildReport(parts({ retryFailed: true })).retryFailed)
  })

  it("is a valid _report.json: it passes the schema after the round trip", () => {
    const text = Schema.encodeSync(EnrichReportJson)(report)
    assert.deepStrictEqual(Schema.decodeUnknownSync(EnrichReportJson)(text), report)
    assert.deepStrictEqual(Object.keys(JSON.parse(text)), [
      "version",
      "generatedAt",
      "model",
      "promptVersion",
      "mode",
      "retryFailed",
      "batchId",
      "totals",
      "failures",
      "usage",
      "cost",
    ])
  })
})

describe("formatTotals and formatUsage", () => {
  const report = buildReport(parts())

  it("write the counts, with the notes only when they are not 0", () => {
    assert.strictEqual(
      formatTotals(report),
      "processed 3, succeeded 2, failed 2, cached 1, out of scope 2, not processed because of --limit 3"
    )
    assert.strictEqual(
      formatTotals(
        buildReport(
          parts({
            outOfScope: 0,
            deferred: 0,
            unreadable: [],
            outcomes: [stored(1)],
          })
        )
      ),
      "processed 1, succeeded 1, failed 0, cached 1"
    )
  })

  it("write the tokens and the cost", () => {
    assert.strictEqual(
      formatUsage(report),
      "tokens: input 3000, output 1500, cache read 0, cache write 0; estimated cost 0.0011 USD (sync, claude-haiku-5-5)"
    )
  })
})
