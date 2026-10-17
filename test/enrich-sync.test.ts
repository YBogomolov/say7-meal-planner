import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import { EnrichedRecipeJson } from "../src/domain/enriched-recipe.ts"
import { EnrichReportJson } from "../src/domain/enrich-report.ts"
import type { EnrichReport } from "../src/domain/enrich-report.ts"
import { ParsedRecipeJson } from "../src/domain/parsed-recipe.ts"
import { buildModelInput, computeInputHash, modelInputText } from "../src/enrich/input.ts"
import { MAX_OUTPUT_TOKENS } from "../src/enrich/llm-types.ts"
import { SYNC_CONCURRENCY } from "../src/enrich/plan.ts"
import { costUsd } from "../src/enrich/pricing.ts"
import { PROMPT_VERSION, retryMessage, SYSTEM_PROMPT } from "../src/enrich/prompt.ts"
import { dryRun, enrichAll } from "../src/enrich/run.ts"
import type { DryRunOptions, EnrichOptions, RunConfig } from "../src/enrich/run.ts"
import type { EnrichStore } from "../src/enrich/store.ts"
import { apiError, answer, makeFakeLlm, rawAnswer, USAGE } from "./support/fake-llm.ts"
import type { FakeLlm } from "./support/fake-llm.ts"
import { DESSERTS, enrichmentFor, idSet, must, parsedRecipe, runOptions, withEnrichDirs } from "./support/enrich.ts"

const CONFIG: RunConfig = {
  concurrency: SYNC_CONCURRENCY,
  poll: { initialMs: 1, factor: 1, maxMs: 1 },
}

const recipesOf = (count: number, start = 1) => Array.from({ length: count }, (_, i) => parsedRecipe(start + i))

interface Context {
  readonly dataDir: string
  readonly outDir: string
  readonly store: Layer.Layer<EnrichStore>
}

const run = (fake: FakeLlm, ctx: Context, overrides: Partial<EnrichOptions> = {}) =>
  enrichAll(runOptions(overrides), CONFIG).pipe(Effect.provide(Layer.mergeAll(ctx.store, fake.layer)))

const names = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return (yield* fs.readDirectory(dir)).toSorted()
  })

const readStored = (dir: string, n: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return Schema.decodeUnknownSync(EnrichedRecipeJson)(yield* fs.readFileString(`${dir}/${n}.json`))
  })

const readReport = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return Schema.decodeUnknownSync(EnrichReportJson)(yield* fs.readFileString(`${dir}/_report.json`))
  })

/** The title of recipe `n` is in its input, so a fake can tell the recipes apart. */
const isRecipe = (n: number, content: string | undefined): boolean => (content ?? "").includes(`Тестовое блюдо ${n}"`)

const firstContent = (request: { readonly messages: ReadonlyArray<{ readonly content: string }> } | undefined) =>
  request?.messages[0]?.content

describe("sync mode: success", () => {
  it.live("stores one file for each recipe, with its meta data, and writes the report", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(fake, ctx)

        assert.strictEqual(report.mode, "sync")
        assert.isNull(report.batchId)
        assert.strictEqual(report.model, "claude-haiku-5-5")
        assert.strictEqual(report.promptVersion, PROMPT_VERSION)
        assert.deepStrictEqual(report.totals, {
          selected: 3,
          outOfScope: 0,
          unreadable: 0,
          cached: 0,
          deferred: 0,
          processed: 3,
          succeeded: 3,
          failed: 0,
        })
        assert.deepStrictEqual(report.failures, [])
        assert.deepStrictEqual(report.usage, {
          inputTokens: 3000,
          outputTokens: 2400,
          cacheReadTokens: 9000,
          cacheCreationTokens: 0,
        })
        assert.closeTo(report.cost.estimatedUsd, costUsd(report.usage, "claude-haiku-5-5", "sync"), 1e-6)

        assert.deepStrictEqual(yield* names(ctx.outDir), ["1.json", "2.json", "3.json", "_report.json"])
        const expectedHash = computeInputHash({
          input: buildModelInput(parsedRecipe(2)),
          promptVersion: PROMPT_VERSION,
          model: "claude-haiku-5-5",
        })
        const stored = yield* readStored(ctx.outDir, 2)
        assert.strictEqual(stored.id, 2)
        assert.strictEqual(stored.enrichmentVersion, 1)
        assert.strictEqual(stored.model, "claude-haiku-5-5")
        assert.strictEqual(stored.promptVersion, PROMPT_VERSION)
        assert.strictEqual(stored.inputHash, expectedHash)
        assert.deepStrictEqual(stored.usage, USAGE)
        assert.deepStrictEqual(stored.enrichment, enrichmentFor(2))
        assert.deepStrictEqual(yield* readReport(ctx.outDir), report)
      })
    )
  )

  it.live("sends the system prompt, the canonical input and the token limit", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        yield* run(fake, ctx)
        assert.lengthOf(fake.requests, 2)
        for (const request of fake.requests) {
          assert.strictEqual(request.model, "claude-haiku-5-5")
          assert.strictEqual(request.system, SYSTEM_PROMPT)
          assert.strictEqual(request.maxTokens, MAX_OUTPUT_TOKENS)
          assert.lengthOf(request.messages, 1)
          assert.strictEqual(request.messages[0]?.role, "user")
        }
        assert.deepStrictEqual(
          fake.requests.map(firstContent).toSorted(),
          recipesOf(2)
            .map((recipe) => modelInputText(buildModelInput(recipe)))
            .toSorted()
        )
        assert.lengthOf(fake.createdBatches, 0)
      })
    )
  )

  it.live("prints one line for each recipe and a summary", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        yield* run(makeFakeLlm({ complete: () => answer(enrichmentFor(2)) }), ctx)
        const lines = ctx.captured.lines
        assert.strictEqual(
          lines.filter((line) => /^\[\d\/3\] \d ok \(input 1000, output 800, cache read 3000\)$/.test(line)).length,
          3
        )
        assert.include(lines.join("\n"), "done: processed 3, succeeded 3, failed 0, cached 0")
        assert.include(lines.join("\n"), "tokens: input 3000, output 2400")
      })
    )
  )

  it.live("uses at most 4 requests at the same time (spec A5)", () =>
    withEnrichDirs(recipesOf(12), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: () => answer(enrichmentFor(2)),
          latencyMs: 15,
        })
        const { report } = yield* run(fake, ctx)
        assert.strictEqual(report.totals.succeeded, 12)
        assert.strictEqual(fake.maxInFlight.value, 4)
      })
    )
  )

  it.live("uses single requests for more than 20 recipes with --sync", () =>
    withEnrichDirs(recipesOf(25), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(fake, ctx, { sync: true })
        assert.strictEqual(report.mode, "sync")
        assert.lengthOf(fake.requests, 25)
        assert.lengthOf(fake.createdBatches, 0)
      })
    )
  )

  it.live("runs 20 recipes in sync mode", () =>
    withEnrichDirs(recipesOf(20), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(fake, ctx)
        assert.strictEqual(report.mode, "sync")
        assert.lengthOf(fake.createdBatches, 0)
      })
    )
  )
})

describe("sync mode: selection and cache (spec A8)", () => {
  it.live("skips the recipes whose stored file has the current hash", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        yield* run(makeFakeLlm({ complete: () => answer(enrichmentFor(2)) }), ctx)
        const again = makeFakeLlm()
        const { report } = yield* run(again, ctx)
        assert.lengthOf(again.requests, 0)
        assert.deepStrictEqual(
          {
            cached: report.totals.cached,
            processed: report.totals.processed,
            selected: report.totals.selected,
          },
          { cached: 3, processed: 0, selected: 3 }
        )
        assert.deepStrictEqual(report.usage.inputTokens, 0)
      })
    )
  )

  it.live("processes a recipe again when the model changes", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function* () {
        yield* run(makeFakeLlm({ complete: () => answer(enrichmentFor(2)) }), ctx)
        const other = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(other, ctx, {
          model: "claude-sonnet-5-5",
        })
        assert.lengthOf(other.requests, 2)
        assert.strictEqual(report.totals.processed, 2)
        assert.strictEqual((yield* readStored(ctx.outDir, 1)).model, "claude-sonnet-5-5")
      })
    )
  )

  it.live("processes only the recipe whose parsed file changed", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* run(makeFakeLlm({ complete: () => answer(enrichmentFor(2)) }), ctx)
        yield* fs.writeFileString(
          `${ctx.dataDir}/parsed/2.json`,
          Schema.encodeSync(ParsedRecipeJson)(parsedRecipe(2, { title: "Другое название" }))
        )
        const again = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(again, ctx)
        assert.lengthOf(again.requests, 1)
        assert.include(firstContent(again.requests[0]), "Другое название")
        assert.deepStrictEqual(
          { cached: report.totals.cached, processed: report.totals.processed },
          { cached: 2, processed: 1 }
        )
      })
    )
  )

  it.live("replaces a stored file that is not valid", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(ctx.outDir, { recursive: true })
        yield* fs.writeFileString(`${ctx.outDir}/1.json`, '{"broken": true}')
        const fake = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(fake, ctx)
        assert.strictEqual(report.totals.processed, 1)
        assert.strictEqual((yield* readStored(ctx.outDir, 1)).id, 1)
      })
    )
  )

  it.live("removes the temporary files of an interrupted write", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(ctx.outDir, { recursive: true })
        yield* fs.writeFileString(`${ctx.outDir}/7.json.tmp`, "half")
        yield* run(makeFakeLlm({ complete: () => answer(enrichmentFor(2)) }), ctx)
        assert.deepStrictEqual(yield* names(ctx.outDir), ["1.json", "_report.json"])
      })
    )
  )

  it.live("skips the recipes out of scope (spec P3.1)", () =>
    withEnrichDirs([parsedRecipe(1), parsedRecipe(2, { categories: [DESSERTS] })], (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(fake, ctx)
        assert.lengthOf(fake.requests, 1)
        assert.strictEqual(report.totals.outOfScope, 1)
        assert.deepStrictEqual(yield* names(ctx.outDir), ["1.json", "_report.json"])
      })
    )
  )

  it.live("with --ids processes the listed recipes and warns about the others", () =>
    withEnrichDirs([...recipesOf(3), parsedRecipe(4, { categories: [DESSERTS] })], (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: () => answer(enrichmentFor(2)),
        })
        const { report } = yield* run(fake, ctx, { ids: idSet(2, 4, 99) })
        assert.lengthOf(fake.requests, 1)
        assert.isTrue(isRecipe(2, firstContent(fake.requests[0])))
        assert.strictEqual(report.totals.processed, 1)
        const warnings = ctx.captured.warnings.join("\n")
        assert.include(warnings, "99")
        assert.include(warnings, "out of scope")
      })
    )
  )

  it.live("with --limit processes the first recipes and counts the others as deferred", () =>
    withEnrichDirs(recipesOf(5), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({ complete: () => answer(enrichmentFor(2)) })
        const { report } = yield* run(fake, ctx, { limit: Option.some(2) })
        assert.lengthOf(fake.requests, 2)
        assert.deepStrictEqual(yield* names(ctx.outDir), ["1.json", "2.json", "_report.json"])
        assert.deepStrictEqual(
          {
            processed: report.totals.processed,
            deferred: report.totals.deferred,
            selected: report.totals.selected,
          },
          {
            processed: 2,
            deferred: 3,
            selected: 5,
          }
        )
      })
    )
  )

  it.live("reports a parsed file that cannot be read and goes on", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${ctx.dataDir}/parsed/9.json`, "not json")
        const { report } = yield* run(makeFakeLlm({ complete: () => answer(enrichmentFor(2)) }), ctx)
        assert.strictEqual(report.totals.unreadable, 1)
        assert.strictEqual(report.totals.succeeded, 2)
        assert.strictEqual(report.totals.failed, 1)
        assert.deepStrictEqual(
          report.failures.map((failure) => [failure.id, failure.kind]),
          [[9, "unreadable"]]
        )
      })
    )
  )

  it.live("fails with a clear error when there is no parsed directory", () =>
    withEnrichDirs([], (ctx) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.remove(`${ctx.dataDir}/parsed`, { recursive: true })
        const error = yield* Effect.flip(run(makeFakeLlm(), ctx))
        assert.include(error.message, "npm run parse")
      })
    )
  )
})

describe("sync mode: failures (spec A9)", () => {
  it.live("retries once after an answer that fails the decoder, and appends the error as a follow-up message", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: (_request, call) => (call === 0 ? rawAnswer("{not json") : answer(enrichmentFor(2))),
        })
        const { report } = yield* run(fake, ctx)
        assert.lengthOf(fake.requests, 2)
        const first = must(fake.requests[0], "first request")
        const second = must(fake.requests[1], "second request")
        assert.lengthOf(first.messages, 1)
        assert.lengthOf(second.messages, 3)
        assert.deepStrictEqual(second.messages.slice(0, 2), [
          must(first.messages[0], "user message"),
          { role: "assistant", content: "{not json" },
        ])
        const follow = must(second.messages[2], "follow-up")
        assert.strictEqual(follow.role, "user")
        assert.strictEqual(follow.content.startsWith(retryMessage("").slice(0, 25)), true)
        assert.strictEqual(second.system, first.system)
        assert.strictEqual(second.maxTokens, first.maxTokens)

        assert.deepStrictEqual(report.totals.succeeded, 1)
        assert.deepStrictEqual(report.failures, [])
        // The tokens of both answers are in the file and in the report.
        assert.strictEqual((yield* readStored(ctx.outDir, 1)).usage.outputTokens, 1600)
        assert.strictEqual(report.usage.inputTokens, 2000)
      })
    )
  )

  it.live("puts the name of the wrong field in the follow-up message", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const wrong = JSON.stringify({ ...enrichmentFor(2), heat: 9 })
        const fake = makeFakeLlm({
          complete: (_request, call) => (call === 0 ? rawAnswer(wrong) : answer(enrichmentFor(2))),
        })
        yield* run(fake, ctx)
        const follow = must(fake.requests[1]?.messages[2], "follow-up")
        assert.include(follow.content, "heat")
      })
    )
  )

  it.live(
    "retries once after an answer that skips a line, and names the line in the follow-up message (spec P3.4)",
    () =>
      withEnrichDirs(recipesOf(1), (ctx) =>
        Effect.gen(function* () {
          const skipped = answer(enrichmentFor(1))
          const fake = makeFakeLlm({
            complete: (_request, call) => (call === 0 ? skipped : answer(enrichmentFor(2))),
          })
          const { report } = yield* run(fake, ctx)
          assert.lengthOf(fake.requests, 2)
          const follow = must(fake.requests[1]?.messages[2], "follow-up")
          assert.include(follow.content, "no item for the lines 1")
          assert.strictEqual(report.totals.succeeded, 1)
          assert.lengthOf((yield* readStored(ctx.outDir, 1)).enrichment.ingredients, 2)
        })
      )
  )

  it.live("fails the recipe when the second answer is also not valid", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: (request) =>
            isRecipe(2, firstContent(request)) ? rawAnswer("still not json") : answer(enrichmentFor(2)),
        })
        const { report } = yield* run(fake, ctx)
        assert.lengthOf(fake.requests, 3)
        assert.deepStrictEqual(report.totals, {
          selected: 2,
          outOfScope: 0,
          unreadable: 0,
          cached: 0,
          deferred: 0,
          processed: 2,
          succeeded: 1,
          failed: 1,
        })
        assert.deepStrictEqual(
          report.failures.map((failure) => [failure.id, failure.kind]),
          [[2, "decode"]]
        )
        // The tokens of the 2 failed answers are billed, so they are in the report.
        assert.strictEqual(report.usage.outputTokens, 3 * 800)
        assert.deepStrictEqual(yield* names(ctx.outDir), ["1.json", "_report.json"])
      })
    )
  )

  it.live("fails a recipe with a line number outside the recipe", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({ complete: () => answer(enrichmentFor(6)) })
        const { report } = yield* run(fake, ctx)
        assert.lengthOf(fake.requests, 2)
        const failure = must(report.failures[0], "failure")
        assert.strictEqual(failure.kind, "decode")
        assert.include(failure.message, "ingredients[2].line is 2")
      })
    )
  )

  it.live("doubles the token limit after max_tokens", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: (_request, call) =>
            call === 0 ? rawAnswer('{"ingredients":[', "max_tokens") : answer(enrichmentFor(2)),
        })
        const { report } = yield* run(fake, ctx)
        assert.deepStrictEqual(
          fake.requests.map((request) => request.maxTokens),
          [8192, 16_000]
        )
        assert.lengthOf(must(fake.requests[1], "second").messages, 1)
        assert.strictEqual(report.totals.succeeded, 1)
      })
    )
  )

  it.live("fails the recipe with the kind max_tokens when the second answer is also cut", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: () => rawAnswer('{"ingredients":[', "max_tokens"),
        })
        const { report } = yield* run(fake, ctx)
        assert.lengthOf(fake.requests, 2)
        assert.deepStrictEqual(
          report.failures.map((failure) => failure.kind),
          ["max_tokens"]
        )
        assert.strictEqual(report.totals.succeeded, 0)
      })
    )
  )

  it.live("repeats the same request after a refusal, then stores the answer", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: (_request, call) => (call === 0 ? rawAnswer("", "refusal") : answer(enrichmentFor(2))),
        })
        const { report } = yield* run(fake, ctx)
        assert.deepStrictEqual(fake.requests[1], fake.requests[0])
        assert.strictEqual(report.totals.succeeded, 1)
      })
    )
  )

  it.live("fails the recipe with the kind refusal when the model refuses twice", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({ complete: () => rawAnswer("", "refusal") })
        const { report } = yield* run(fake, ctx)
        assert.lengthOf(fake.requests, 2)
        assert.deepStrictEqual(
          report.failures.map((failure) => failure.kind),
          ["refusal"]
        )
      })
    )
  )

  it.live("does not retry after another stop_reason", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: () => rawAnswer("{}", "pause_turn"),
        })
        const { report } = yield* run(fake, ctx)
        assert.lengthOf(fake.requests, 1)
        assert.deepStrictEqual(
          report.failures.map((failure) => failure.kind),
          ["stop_reason"]
        )
      })
    )
  )

  it.live("fails only the recipe that has an API error", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: (request) =>
            isRecipe(2, firstContent(request)) ? apiError("server", 529, "Overloaded") : answer(enrichmentFor(2)),
        })
        const { report } = yield* run(fake, ctx)
        assert.strictEqual(report.totals.succeeded, 2)
        assert.deepStrictEqual(
          report.failures.map((failure) => [failure.id, failure.kind, failure.message]),
          [[2, "api_error", "Overloaded"]]
        )
        assert.deepStrictEqual(yield* names(ctx.outDir), ["1.json", "3.json", "_report.json"])
      })
    )
  )

  it.live("keeps the tokens of the first answer when the second request has an API error", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: (_request, call) => (call === 0 ? rawAnswer("{bad") : apiError("connection", null, "reset")),
        })
        const { report } = yield* run(fake, ctx)
        assert.deepStrictEqual(
          report.failures.map((failure) => failure.kind),
          ["api_error"]
        )
        assert.strictEqual(report.usage.outputTokens, 800)
      })
    )
  )

  it.live("stops the run after a wrong key, and does not write a report", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm({
          complete: () => apiError("auth", 401, "invalid x-api-key"),
        })
        const error = yield* Effect.flip(run(fake, ctx))
        assert.strictEqual(error._tag, "LlmApiError")
        assert.include(error.message, "invalid x-api-key")
        const fs = yield* FileSystem.FileSystem
        assert.isFalse(yield* fs.exists(`${ctx.outDir}/_report.json`))
      })
    )
  )

  it.live("stops the run when the account has no credit or no permission", () =>
    Effect.forEach(
      ["billing", "permission"] as const,
      (kind) =>
        withEnrichDirs(recipesOf(2), (ctx) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(run(makeFakeLlm({ complete: () => apiError(kind, 400, "stop") }), ctx))
            assert.strictEqual(error._tag, "LlmApiError")
          })
        ),
      { discard: true }
    )
  )
})

describe("--retry-failed (spec A9)", () => {
  it.live("processes the failures of the last report in sync mode and nothing else", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        const first = makeFakeLlm({
          complete: (request) => (isRecipe(2, firstContent(request)) ? rawAnswer("oops") : answer(enrichmentFor(2))),
        })
        const before = yield* run(first, ctx)
        assert.deepStrictEqual(
          before.report.failures.map((failure) => failure.id),
          [2]
        )

        const second = makeFakeLlm({
          complete: () => answer(enrichmentFor(2)),
        })
        const { report } = yield* run(second, ctx, { retryFailed: true })
        assert.lengthOf(second.requests, 1)
        assert.isTrue(isRecipe(2, firstContent(second.requests[0])))
        assert.strictEqual(report.retryFailed, true)
        assert.strictEqual(report.mode, "sync")
        assert.deepStrictEqual(report.failures, [])
        assert.deepStrictEqual(
          {
            selected: report.totals.selected,
            processed: report.totals.processed,
            succeeded: report.totals.succeeded,
          },
          { selected: 1, processed: 1, succeeded: 1 }
        )
        assert.deepStrictEqual(yield* names(ctx.outDir), ["1.json", "2.json", "3.json", "_report.json"])
        assert.deepStrictEqual((yield* readReport(ctx.outDir)).failures, [])
      })
    )
  )

  it.live("keeps a failure in the report when the retry also fails", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function* () {
        const bad = makeFakeLlm({
          complete: (request) => (isRecipe(1, firstContent(request)) ? rawAnswer("oops") : answer(enrichmentFor(2))),
        })
        yield* run(bad, ctx)
        const { report } = yield* run(makeFakeLlm({ complete: () => rawAnswer("oops") }), ctx, { retryFailed: true })
        assert.deepStrictEqual(
          report.failures.map((failure) => [failure.id, failure.kind]),
          [[1, "decode"]]
        )
      })
    )
  )

  it.live("fails with a clear error when there is no report", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function* () {
        const fake = makeFakeLlm()
        const error = yield* Effect.flip(run(fake, ctx, { retryFailed: true }))
        assert.strictEqual(error._tag, "EnrichRunError")
        assert.include(error.message, "_report.json")
        assert.lengthOf(fake.requests, 0)
      })
    )
  )
})

describe("dryRun", () => {
  const BOTH = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const
  const dry = (ctx: Context, overrides: Partial<DryRunOptions> = {}) =>
    dryRun({
      ids: Option.none(),
      limit: Option.none(),
      sync: false,
      retryFailed: false,
      extraScopeIds: new Set(),
      models: BOTH,
      ...overrides,
    }).pipe(Effect.provide(ctx.store))

  it.live("builds and checks the requests of the recipes in scope, sends no request and writes no file", () =>
    withEnrichDirs([...recipesOf(3), parsedRecipe(4, { categories: [DESSERTS] })], (ctx) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const summary = yield* dry(ctx)
        const text = ctx.captured.lines.join("\n")
        assert.include(text, "dry run: no request goes to the API and no file changes")
        assert.include(text, "parsed files: 4, unreadable 0, out of scope 1, in scope 3")
        assert.include(text, "requests: 3 (a real run uses sync mode)")
        assert.include(text, "validation: 3 requests for 2 models, no problem")
        assert.include(text, "claude-haiku-5-5")
        assert.include(text, "claude-sonnet-5-5")
        assert.deepStrictEqual(
          {
            inScope: summary.inScope,
            requests: summary.requests,
            problems: summary.problems,
          },
          { inScope: 3, requests: 3, problems: [] }
        )
        assert.isFalse(yield* fs.exists(ctx.outDir))
      })
    )
  )

  it.live("shows the mode that the run would use", () =>
    withEnrichDirs(recipesOf(25), (ctx) =>
      Effect.gen(function* () {
        yield* dry(ctx)
        yield* dry(ctx, { sync: true })
        const modes = ctx.captured.lines.filter((line) => line.startsWith("requests:"))
        assert.deepStrictEqual(modes, [
          "requests: 25 (a real run uses batch mode)",
          "requests: 25 (a real run uses sync mode)",
        ])
      })
    )
  )

  it.live("counts the work of a full run: stored files do not change the numbers", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        yield* run(makeFakeLlm({ complete: () => answer(enrichmentFor(2)) }), ctx, { limit: Option.some(2) })
        const summary = yield* dry(ctx)
        assert.strictEqual(summary.requests, 3)
      })
    )
  )

  it.live("takes the first n recipes with --limit, and keeps the count of the recipes in scope", () =>
    withEnrichDirs(recipesOf(5), (ctx) =>
      Effect.gen(function* () {
        const summary = yield* dry(ctx, { limit: Option.some(2) })
        assert.deepStrictEqual({ inScope: summary.inScope, requests: summary.requests }, { inScope: 5, requests: 2 })
      })
    )
  )

  it.live("selects the recipes of --ids", () =>
    withEnrichDirs(recipesOf(5), (ctx) =>
      Effect.gen(function* () {
        const summary = yield* dry(ctx, { ids: idSet(2, 4) })
        assert.deepStrictEqual({ files: summary.files, requests: summary.requests }, { files: 2, requests: 2 })
      })
    )
  )

  it.live("estimates only the model that is asked for", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        const summary = yield* dry(ctx, { models: ["claude-sonnet-5-5"] })
        assert.deepStrictEqual(
          summary.estimates.map((estimate) => estimate.model),
          ["claude-sonnet-5-5"]
        )
        const text = ctx.captured.lines.join("\n")
        assert.include(text, "for 1 model, no problem")
        assert.notInclude(text, "claude-haiku-5-5")
      })
    )
  )

  it.live("counts a parsed file that cannot be read, and goes on", () =>
    withEnrichDirs(recipesOf(2), (ctx) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${ctx.dataDir}/parsed/7.json`, "{ not json")
        const summary = yield* dry(ctx)
        assert.deepStrictEqual(
          {
            files: summary.files,
            unreadable: summary.unreadable,
            requests: summary.requests,
          },
          { files: 3, unreadable: 1, requests: 2 }
        )
      })
    )
  )

  it.live("selects the failures of the last report with --retry-failed, and fails when there is no report", () =>
    withEnrichDirs(recipesOf(3), (ctx) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(dry(ctx, { retryFailed: true }))
        assert.strictEqual(error._tag, "EnrichRunError")
        assert.include(error.message, "_report.json")

        const fake = makeFakeLlm({
          complete: (request) =>
            isRecipe(2, firstContent(request)) ? rawAnswer("not json") : answer(enrichmentFor(2)),
        })
        yield* run(fake, ctx)
        const summary = yield* dry(ctx, { retryFailed: true })
        assert.deepStrictEqual(
          {
            files: summary.files,
            requests: summary.requests,
            mode: summary.mode,
          },
          {
            files: 1,
            requests: 1,
            mode: "sync",
          }
        )
      })
    )
  )
})

describe("a report from a run has no key", () => {
  it.live("is plain JSON with the fields of the spec A10", () =>
    withEnrichDirs(recipesOf(1), (ctx) =>
      Effect.gen(function* () {
        const { report } = yield* run(makeFakeLlm({ complete: () => answer(enrichmentFor(2)) }), ctx)
        const keys = Object.keys(report).toSorted()
        assert.deepStrictEqual(keys, [
          "batchId",
          "cost",
          "failures",
          "generatedAt",
          "mode",
          "model",
          "promptVersion",
          "retryFailed",
          "totals",
          "usage",
          "version",
        ])
        const parsed: EnrichReport = report
        assert.strictEqual(parsed.cost.currency, "USD")
      })
    )
  )
})
