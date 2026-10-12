import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import { Llm } from "../src/enrich/api.ts"
import { BatchState, BatchStateJson, EnrichReportJson } from "../src/domain/enrich-report.ts"
import { EnrichedRecipeJson } from "../src/domain/enriched-recipe.ts"
import { buildModelInput, computeInputHash, modelInputText } from "../src/enrich/input.ts"
import type { BatchEntry, BatchItem, BatchOutcome } from "../src/enrich/llm-types.ts"
import { SYNC_CONCURRENCY } from "../src/enrich/plan.ts"
import { costUsd } from "../src/enrich/pricing.ts"
import { PROMPT_VERSION, SYSTEM_PROMPT } from "../src/enrich/prompt.ts"
import { enrichAll } from "../src/enrich/run.ts"
import type { EnrichOptions, RunConfig } from "../src/enrich/run.ts"
import { EnrichStore } from "../src/enrich/store.ts"
import { answer, apiError, batchResultsOnly, makeFakeLlm, rawAnswer, USAGE } from "./support/fake-llm.ts"
import type { FakeLlm } from "./support/fake-llm.ts"
import { enrichmentFor, id, must, parsedRecipe, runOptions, withEnrichDirs } from "./support/enrich.ts"

const CONFIG: RunConfig = { concurrency: SYNC_CONCURRENCY, poll: { initialMs: 1, factor: 1, maxMs: 1 } }

const recipesOf = (count: number, start = 1) => Array.from({ length: count }, (_, i) => parsedRecipe(start + i))

interface Context {
  readonly dataDir: string
  readonly outDir: string
  readonly store: Layer.Layer<EnrichStore>
}

const succeeded = (lines = 2): BatchOutcome => ({ _tag: "Succeeded", completion: answer(enrichmentFor(lines)) })

const names = (dir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return (yield* fs.readDirectory(dir)).toSorted()
  })

const readStored = (dir: string, n: number) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return Schema.decodeUnknownSync(EnrichedRecipeJson)(yield* fs.readFileString(`${dir}/${n}.json`))
  })

const run = (layer: Layer.Layer<Llm>, ctx: Context, overrides: Partial<EnrichOptions> = {}) =>
  enrichAll(runOptions(overrides), CONFIG).pipe(Effect.provide(Layer.mergeAll(ctx.store, layer)))

/** A batch of 21 recipes: the position 3 has an error, the position 5 has an answer that is not valid. */
const mixedReply = (_entry: BatchEntry, position: number): BatchOutcome =>
  position === 3
    ? { _tag: "Errored", errorType: "overloaded_error", message: "Overloaded" }
    : position === 5
    ? { _tag: "Succeeded", completion: rawAnswer("not json") }
    : succeeded()

const state = (parts: { readonly model?: "claude-haiku-5-5" | "claude-sonnet-5-5"; readonly ids?: ReadonlyArray<number> } = {}) =>
  Schema.decodeUnknownSync(BatchState)({
    version: 1,
    batchId: "msgbatch_resume_7",
    model: parts.model ?? "claude-haiku-5-5",
    promptVersion: PROMPT_VERSION,
    createdAt: "2026-10-12T10:00:00.000Z",
    recipes: (parts.ids ?? [1, 2]).map((n) => ({ id: n, inputHash: String(n).padStart(64, "a"), lineCount: 2 }))
  })

const item = (n: number, outcome: BatchOutcome): BatchItem => ({ customId: `recipe-${n}`, outcome })

describe("batch mode", () => {
  it.live("sends 21 recipes as one batch, polls, stores the valid answers and reports the failures", () =>
    withEnrichDirs(recipesOf(21), (ctx) =>
      Effect.gen(function*() {
        const fake = makeFakeLlm({ batch: { pollsBeforeEnd: 2, reply: mixedReply } })
        const seen: Array<Option.Option<BatchState>> = []
        // Read `_batch.json` at each poll, to see that it exists while the batch runs.
        const watching = Layer.effect(
          Llm,
          Effect.gen(function*() {
            const inner = yield* Llm
            const store = yield* EnrichStore
            return Llm.of({
              ...inner,
              getBatch: (batchId) =>
                store.readBatch.pipe(
                  Effect.orDie,
                  Effect.tap((current) => Effect.sync(() => void seen.push(current))),
                  Effect.andThen(inner.getBatch(batchId))
                )
            })
          })
        ).pipe(Layer.provide(Layer.mergeAll(fake.layer, ctx.store)))

        const { report } = yield* run(watching, ctx)

        // One batch with a request for each recipe.
        assert.lengthOf(fake.requests, 0)
        assert.lengthOf(fake.createdBatches, 1)
        const entries = must(fake.createdBatches[0], "the batch")
        assert.deepStrictEqual(entries.map((entry) => entry.customId), recipesOf(21).map((recipe) => `recipe-${recipe.id}`))
        const entry = must(entries[0], "first entry")
        assert.strictEqual(entry.request.system, SYSTEM_PROMPT)
        assert.strictEqual(entry.request.model, "claude-haiku-5-5")
        assert.deepStrictEqual(entry.request.messages, [
          { role: "user", content: modelInputText(buildModelInput(parsedRecipe(1))) }
        ])

        // The batch ID is in `_batch.json` while the run waits, and the file is gone at the end.
        assert.strictEqual(fake.polls.count, 3)
        assert.lengthOf(seen, 3)
        assert.isTrue(seen.every(Option.isSome))
        const written = must(Option.getOrUndefined(must(seen[0], "first poll")), "_batch.json")
        assert.strictEqual(written.batchId, fake.batchId)
        assert.strictEqual(written.model, "claude-haiku-5-5")
        assert.strictEqual(written.promptVersion, PROMPT_VERSION)
        assert.deepStrictEqual(written.recipes.map((recipe) => recipe.id), recipesOf(21).map((recipe) => recipe.id))
        assert.isTrue(written.recipes.every((recipe) => recipe.lineCount === 2))
        const files = yield* names(ctx.outDir)
        assert.notInclude(files, "_batch.json")

        // 19 valid answers are stored. The error and the answer that is not valid are failures, with no retry.
        assert.strictEqual(report.mode, "batch")
        assert.strictEqual(report.batchId, fake.batchId)
        assert.deepStrictEqual(
          { processed: report.totals.processed, succeeded: report.totals.succeeded, failed: report.totals.failed },
          { processed: 21, succeeded: 19, failed: 2 }
        )
        assert.deepStrictEqual(report.failures.map((failure) => [failure.id, failure.kind]), [[4, "api_error"], [6, "decode"]])
        assert.include(must(report.failures[0], "failure").message, "overloaded_error: Overloaded")
        assert.lengthOf(files.filter((name) => /^\d+\.json$/.test(name)), 19)
        assert.notInclude(files, "4.json")
        assert.notInclude(files, "6.json")

        // The prices are the batch prices (50 %).
        assert.strictEqual(report.cost.batchFactor, 0.5)
        assert.closeTo(report.cost.estimatedUsd, costUsd(report.usage, "claude-haiku-5-5", "batch"), 1e-6)
        assert.strictEqual(report.usage.outputTokens, 20 * USAGE.outputTokens)

        const stored = yield* readStored(ctx.outDir, 1)
        assert.strictEqual(stored.inputHash, computeInputHash({
          input: buildModelInput(parsedRecipe(1)),
          promptVersion: PROMPT_VERSION,
          model: "claude-haiku-5-5"
        }))
        assert.strictEqual(stored.model, "claude-haiku-5-5")
        assert.include(ctx.captured.lines.join("\n"), "created with 21 requests")
        assert.include(ctx.captured.lines.join("\n"), "[21/21]")
      })))

  it.live("does not call the single-request endpoint", () =>
    withEnrichDirs(recipesOf(21), (ctx) =>
      Effect.gen(function*() {
        const fake = makeFakeLlm({ batch: { reply: () => succeeded() } })
        yield* run(fake.layer, ctx)
        assert.lengthOf(fake.requests, 0)
      })))

  it.live("skips the cached recipes and sends only the others", () =>
    withEnrichDirs(recipesOf(30), (ctx) =>
      Effect.gen(function*() {
        const first = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        yield* run(first.layer, ctx, { sync: true, limit: Option.some(5) })
        assert.lengthOf(first.requests, 5)

        const second = makeFakeLlm({ batch: { reply: () => succeeded() } })
        const { report } = yield* run(second.layer, ctx)
        assert.lengthOf(must(second.createdBatches[0], "the batch"), 25)
        assert.deepStrictEqual(
          { cached: report.totals.cached, processed: report.totals.processed, selected: report.totals.selected },
          { cached: 5, processed: 25, selected: 30 }
        )
      })))

  it.live("uses sync mode when the recipes that need a call are 20 or fewer", () =>
    withEnrichDirs(recipesOf(30), (ctx) =>
      Effect.gen(function*() {
        yield* run(makeFakeLlm({ complete: () => answer(enrichmentFor(2)) }).layer, ctx, { sync: true, limit: Option.some(10) })
        const second = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(second.layer, ctx)
        assert.strictEqual(report.mode, "sync")
        assert.lengthOf(second.requests, 20)
        assert.lengthOf(second.createdBatches, 0)
      })))

  it.live("reports each kind of result that is not an answer", () =>
    withEnrichDirs(recipesOf(24), (ctx) =>
      Effect.gen(function*() {
        const fake = makeFakeLlm({
          batch: {
            reply: (_entry, position) =>
              position === 0
                ? { _tag: "Expired" }
                : position === 1
                ? { _tag: "Canceled" }
                : position === 2
                ? "omit"
                : position === 3
                ? { _tag: "Succeeded", completion: rawAnswer("", "refusal") }
                : position === 4
                ? { _tag: "Succeeded", completion: rawAnswer('{"ing', "max_tokens") }
                : succeeded()
          }
        })
        const { report } = yield* run(fake.layer, ctx)
        assert.deepStrictEqual(report.failures.map((failure) => [failure.id, failure.kind]), [
          [1, "batch_expired"],
          [2, "batch_canceled"],
          [3, "batch_missing"],
          [4, "refusal"],
          [5, "max_tokens"]
        ])
        assert.strictEqual(report.totals.succeeded, 19)
      })))

  it.live("fails when the batch cannot be created, and leaves no _batch.json", () =>
    withEnrichDirs(recipesOf(21), (ctx) =>
      Effect.gen(function*() {
        const fake = makeFakeLlm({
          batch: { reply: () => succeeded(), createError: apiError("invalid_request", 400, "bad request") }
        })
        const error = yield* Effect.flip(run(fake.layer, ctx))
        assert.strictEqual(error._tag, "LlmApiError")
        assert.deepStrictEqual(yield* names(ctx.outDir), [])
      })))

  it.live("--retry-failed processes the failures of a batch in sync mode", () =>
    withEnrichDirs(recipesOf(21), (ctx) =>
      Effect.gen(function*() {
        const batch = makeFakeLlm({ batch: { reply: mixedReply } })
        const before = yield* run(batch.layer, ctx)
        assert.deepStrictEqual(before.report.failures.map((failure) => failure.id), [4, 6])

        const retry = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(retry.layer, ctx, { retryFailed: true })
        assert.lengthOf(retry.requests, 2)
        assert.lengthOf(retry.createdBatches, 0)
        assert.strictEqual(report.mode, "sync")
        assert.deepStrictEqual(report.failures, [])
        assert.lengthOf((yield* names(ctx.outDir)).filter((name) => /^\d+\.json$/.test(name)), 21)
      })))
})

describe("resume from _batch.json (spec A5)", () => {
  const withBatchFile = (batch: BatchState, ctx: Context) =>
    EnrichStore.use((store) => store.writeBatch(batch)).pipe(Effect.provide(ctx.store))

  it.live("polls the batch from the file, stores the results and removes the file", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function*() {
        const batch = state()
        yield* withBatchFile(batch, ctx)
        const layer = batchResultsOnly(batch.batchId, [item(1, succeeded()), item(2, succeeded())])
        const { report } = yield* run(layer, ctx)

        assert.strictEqual(report.mode, "batch")
        assert.strictEqual(report.batchId, "msgbatch_resume_7")
        assert.deepStrictEqual(report.totals.succeeded, 2)
        assert.deepStrictEqual(yield* names(ctx.outDir), ["1.json", "2.json", "_report.json"])
        const stored = yield* readStored(ctx.outDir, 2)
        assert.strictEqual(stored.inputHash, must(batch.recipes[1], "recipe").inputHash)
        assert.strictEqual(stored.model, "claude-haiku-5-5")
        assert.strictEqual(stored.promptVersion, PROMPT_VERSION)
        assert.include(ctx.captured.lines.join("\n"), "resume: batch msgbatch_resume_7 with 2 recipes")
        const fs = yield* FileSystem.FileSystem
        assert.deepStrictEqual(
          Schema.decodeUnknownSync(EnrichReportJson)(yield* fs.readFileString(`${ctx.outDir}/_report.json`)),
          report
        )
      })))

  it.live("ignores the other flags and sends nothing new", () =>
    withEnrichDirs(recipesOf(30), (ctx) =>
      Effect.gen(function*() {
        const batch = state()
        yield* withBatchFile(batch, ctx)
        const layer = batchResultsOnly(batch.batchId, [item(1, succeeded()), item(2, succeeded())])
        const { report } = yield* run(layer, ctx, { sync: true, limit: Option.some(3) })
        assert.strictEqual(report.totals.processed, 2)
        assert.deepStrictEqual(yield* names(ctx.outDir), ["1.json", "2.json", "_report.json"])
      })))

  it.live("uses the stored line count to check the lines of the answers", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function*() {
        const batch = state()
        yield* withBatchFile(batch, ctx)
        const layer = batchResultsOnly(batch.batchId, [item(1, succeeded(3)), item(2, succeeded(2))])
        const { report } = yield* run(layer, ctx)
        assert.deepStrictEqual(report.failures.map((failure) => [failure.id, failure.kind]), [[1, "decode"]])
      })))

  it.live("reports a recipe without a result and warns about a result without a recipe", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function*() {
        const batch = state()
        yield* withBatchFile(batch, ctx)
        const layer = batchResultsOnly(batch.batchId, [item(1, succeeded()), item(77, succeeded())])
        const { report } = yield* run(layer, ctx)
        assert.deepStrictEqual(report.failures.map((failure) => [failure.id, failure.kind]), [[2, "batch_missing"]])
        assert.include(ctx.captured.warnings.join("\n"), "recipe-77")
      })))

  it.live("keeps the first result when the stream repeats a request", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function*() {
        const batch = state()
        yield* withBatchFile(batch, ctx)
        const layer = batchResultsOnly(batch.batchId, [
          item(1, succeeded()),
          item(1, { _tag: "Expired" }),
          item(2, succeeded())
        ])
        const { report } = yield* run(layer, ctx)
        assert.deepStrictEqual(report.failures, [])
        assert.strictEqual(report.totals.succeeded, 2)
      })))

  it.live("refuses a batch of another model and keeps the file", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function*() {
        yield* withBatchFile(state({ model: "claude-sonnet-5-5" }), ctx)
        const error = yield* Effect.flip(run(batchResultsOnly("x", []), ctx))
        assert.strictEqual(error._tag, "EnrichRunError")
        assert.include(error.message, "msgbatch_resume_7")
        assert.include(error.message, "--model claude-sonnet-5-5")
        assert.include(yield* names(ctx.outDir), "_batch.json")
      })))

  it.live("fails with a clear error when _batch.json is not valid", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(ctx.outDir, { recursive: true })
        yield* fs.writeFileString(`${ctx.outDir}/_batch.json`, "{}")
        const error = yield* Effect.flip(run(batchResultsOnly("x", []), ctx))
        assert.strictEqual(error._tag, "ControlFileInvalidError")
        assert.include(error.message, "batch")
      })))

  it.live("writes the same _batch.json that it reads", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const batch = state({ ids: [1, 2] })
        yield* withBatchFile(batch, ctx)
        const text = yield* fs.readFileString(`${ctx.outDir}/_batch.json`)
        assert.deepStrictEqual(Schema.decodeUnknownSync(BatchStateJson)(text), batch)
        assert.strictEqual(must(batch.recipes[0], "recipe").id, id(1))
      })))
})

describe("a fake batch API", () => {
  it.live("shows in_progress for the polls before the end", () =>
    withEnrichDirs(recipesOf(21), (ctx) =>
      Effect.gen(function*() {
        const fake: FakeLlm = makeFakeLlm({ batch: { pollsBeforeEnd: 3, reply: () => succeeded() } })
        yield* run(fake.layer, ctx)
        assert.strictEqual(fake.polls.count, 4)
        assert.include(ctx.captured.lines.join("\n"), "in_progress; processing 21")
        assert.include(ctx.captured.lines.join("\n"), ": ended;")
      })))
})
