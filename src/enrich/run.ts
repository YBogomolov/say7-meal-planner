import { Console, DateTime, Effect, Option, Ref, Result, Schema, Stream } from "effect"
import { ENRICHMENT_VERSION, addUsage, NO_USAGE } from "../domain/enriched-recipe.ts"
import type { EnrichedRecipe, Enrichment, ModelName, TokenUsage } from "../domain/enriched-recipe.ts"
import type { BatchState, EnrichFailure, EnrichReport, FailureKind, RunMode } from "../domain/enrich-report.ts"
import type { ParsedRecipe } from "../domain/parsed-recipe.ts"
import type { RecipeId } from "../domain/recipe.ts"
import type { StoreError } from "../store/fs.ts"
import { Llm } from "./api.ts"
import { judgeCompletion, retryRequest } from "./decode.ts"
import { formatDryRun, summariseDryRun } from "./dry-run.ts"
import type { DryRunSummary } from "./dry-run.ts"
import { buildModelInput } from "./input.ts"
import { isFatal, redactKeyLike } from "./llm-types.ts"
import type { BatchInfo, BatchItem, LlmApiError, LlmRequest } from "./llm-types.ts"
import { chooseMode, customIdOf, planEnrichment, selectIds, SYNC_CONCURRENCY } from "./plan.ts"
import type { EnrichPlan, PlannedRecipe } from "./plan.ts"
import { PROMPT_VERSION } from "./prompt.ts"
import { buildReport, formatTotals, formatUsage } from "./report.ts"
import type { RecipeOutcome } from "./report.ts"
import { requestFor } from "./request.ts"
import { isInScope } from "./scope.ts"
import { EnrichStore } from "./store.ts"
import type { ControlFileInvalidError } from "./store.ts"

/** A problem with the request of the user, for example a batch of another model that waits in the output directory. */
export class EnrichRunError extends Schema.TaggedError<EnrichRunError>()("EnrichRunError", {
  message: Schema.String,
}) {}

export type EnrichError = StoreError | ControlFileInvalidError | LlmApiError | EnrichRunError

export interface EnrichOptions {
  readonly model: ModelName
  /** Process only these recipes. */
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
  /** Process only the first n recipes that need a call. */
  readonly limit: Option.Option<number>
  /** Use single requests also for more than 20 recipes. */
  readonly sync: boolean
  /** Process the failures of the last `_report.json` in sync mode. */
  readonly retryFailed: boolean
}

/** The options of `--dry-run`. Without `--model`, the dry run estimates every supported model. */
export interface DryRunOptions {
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
  readonly limit: Option.Option<number>
  readonly sync: boolean
  readonly retryFailed: boolean
  readonly models: ReadonlyArray<ModelName>
}

/** Waits between two polls of a batch: `initialMs`, then each wait `factor` times longer, up to `maxMs`. */
export interface PollConfig {
  readonly initialMs: number
  readonly factor: number
  readonly maxMs: number
}

export interface RunConfig {
  readonly concurrency: number
  readonly poll: PollConfig
}

export const defaultRunConfig: RunConfig = {
  concurrency: SYNC_CONCURRENCY,
  poll: { initialMs: 15_000, factor: 1.5, maxMs: 300_000 },
}

/** Wait before poll number `attempt` (counted from 0), in ms. */
export const pollDelayMs = (config: PollConfig, attempt: number): number =>
  Math.min(config.maxMs, Math.round(config.initialMs * config.factor ** attempt))

/** First line of a message, cut to 160 characters. */
const brief = (message: string): string => {
  const line = redactKeyLike(message.split("\n")[0] ?? "")
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}

/** `[k/n] <id> ok (input 1000, output 800, cache read 3000)` or `[k/n] <id> failed <kind> (<message>)` */
export const formatOutcomeLine = (line: {
  readonly k: number
  readonly n: number
  readonly outcome: RecipeOutcome
}): string => {
  const { k, n, outcome } = line
  const prefix = `[${k}/${n}] ${outcome.id}`
  if (outcome._tag === "Failed") {
    return `${prefix} failed ${outcome.kind} (${brief(outcome.message)})`
  }
  const { usage } = outcome
  return `${prefix} ok (input ${usage.inputTokens}, output ${usage.outputTokens}, cache read ${usage.cacheReadTokens})`
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

interface Selection {
  readonly recipes: ReadonlyArray<ParsedRecipe>
  readonly unreadable: ReadonlyArray<EnrichFailure>
}

/**
 * Read the parsed files that the flags select.
 * With `--retry-failed`, the selection is the failure list of the last `_report.json`.
 */
const loadSelection = (
  options: Pick<EnrichOptions, "ids" | "retryFailed">
): Effect.Effect<Selection, EnrichError, EnrichStore> =>
  Effect.gen(function* () {
    const store = yield* EnrichStore

    let requested = options.ids
    if (options.retryFailed) {
      const report = yield* store.readReport
      if (Option.isNone(report)) {
        return yield* new EnrichRunError({
          message: "There is no _report.json in the output directory. Nothing to retry.",
        })
      }
      requested = Option.some(new Set(report.value.failures.map((failure) => failure.id)))
    }

    const selection = selectIds(yield* store.listParsedIds, requested)
    if (selection.unknown.length > 0) {
      yield* Console.warn(`warning: IDs without a parsed file: ${selection.unknown.join(", ")}`)
    }

    const loaded = yield* Effect.forEach(
      selection.selected,
      (id) => Effect.result(store.readParsed(id)).pipe(Effect.map((result) => ({ id, result }))),
      { concurrency: 8 }
    )
    const recipes: Array<ParsedRecipe> = []
    const unreadable: Array<EnrichFailure> = []
    for (const { id, result } of loaded) {
      if (Result.isSuccess(result)) {
        recipes.push(result.success)
      } else {
        unreadable.push({
          id,
          kind: "unreadable",
          message: result.failure.message,
        })
      }
    }
    return { recipes, unreadable }
  })

interface Work {
  readonly plan: EnrichPlan
  readonly unreadable: ReadonlyArray<EnrichFailure>
}

/** Decide which of the selected recipes need the model: those in scope without a stored file of the current `inputHash`. */
const gatherWork = (options: EnrichOptions): Effect.Effect<Work, EnrichError, EnrichStore> =>
  Effect.gen(function* () {
    const store = yield* EnrichStore
    const { recipes, unreadable } = yield* loadSelection(options)

    const stored = yield* Effect.forEach(
      recipes,
      (recipe) => store.readEnriched(recipe.id).pipe(Effect.map((file) => [recipe.id, file] as const)),
      { concurrency: 8 }
    )
    const storedHashes = new Map<RecipeId, string>(
      stored.flatMap(([id, file]) => (Option.isSome(file) ? [[id, file.value.inputHash] as const] : []))
    )

    const plan = planEnrichment({
      recipes,
      model: options.model,
      promptVersion: PROMPT_VERSION,
      storedHashes,
      limit: options.limit,
    })
    if (Option.isSome(options.ids) && !options.retryFailed && plan.outOfScope.length > 0) {
      yield* Console.warn(`warning: IDs out of scope (spec P3.1), skipped: ${plan.outOfScope.join(", ")}`)
    }
    return { plan, unreadable }
  })

/**
 * The dry run (task: no network, no key).
 * Build the request of every recipe in scope, validate the requests, print the sizes and the estimated cost for each model.
 * Send no request and write no file. The stored files do not change the numbers: the dry run counts a full run.
 */
export const dryRun = (options: DryRunOptions): Effect.Effect<DryRunSummary, EnrichError, EnrichStore> =>
  Effect.gen(function* () {
    const { recipes, unreadable } = yield* loadSelection(options)
    const inScope = recipes
      .filter(isInScope)
      .toSorted((a, b) => a.id - b.id)
      .map((recipe) => ({ id: recipe.id, input: buildModelInput(recipe) }))
    const summary = summariseDryRun({
      files: recipes.length + unreadable.length,
      unreadable: unreadable.length,
      outOfScope: recipes.length - inScope.length,
      inScope,
      limit: options.limit,
      models: options.models,
      sync: options.sync,
      retryFailed: options.retryFailed,
    })
    for (const line of formatDryRun(summary)) {
      yield* Console.log(line)
    }
    return summary
  })

/** Build the stored file of a recipe. */
const storedRecipe = (parts: {
  readonly id: RecipeId
  readonly model: ModelName
  readonly promptVersion: number
  readonly inputHash: string
  readonly createdAt: string
  readonly usage: TokenUsage
  readonly enrichment: Enrichment
}): EnrichedRecipe => ({ ...parts, enrichmentVersion: ENRICHMENT_VERSION })

/**
 * One recipe in sync mode (spec A5, A9): one request, and a second request if the first answer fails.
 * A wrong key, a key without permission or no credit stops the run. Any other API error fails only this recipe.
 */
const enrichOne = (
  model: ModelName,
  planned: PlannedRecipe
): Effect.Effect<RecipeOutcome, StoreError | LlmApiError, Llm | EnrichStore> =>
  Effect.gen(function* () {
    const llm = yield* Llm
    const store = yield* EnrichStore
    const { id } = planned

    const failed = (kind: FailureKind, message: string, usage: TokenUsage): RecipeOutcome => ({
      _tag: "Failed",
      id,
      kind,
      message,
      usage,
    })

    const ask = (request: LlmRequest) =>
      Effect.result(llm.complete(request)).pipe(
        Effect.flatMap((result) =>
          Result.isFailure(result) && isFatal(result.failure) ? Effect.fail(result.failure) : Effect.succeed(result)
        )
      )

    const save = (enrichment: Enrichment, usage: TokenUsage): Effect.Effect<RecipeOutcome, StoreError> =>
      nowIso.pipe(
        Effect.flatMap((createdAt) =>
          Effect.uninterruptible(
            store.writeEnriched(
              storedRecipe({
                id,
                model,
                promptVersion: PROMPT_VERSION,
                inputHash: planned.inputHash,
                createdAt,
                usage,
                enrichment,
              })
            )
          )
        ),
        Effect.as<RecipeOutcome>({ _tag: "Stored", id, usage })
      )

    const first = requestFor(model, planned)
    const firstTry = yield* ask(first)
    if (Result.isFailure(firstTry)) {
      return failed("api_error", firstTry.failure.message, NO_USAGE)
    }
    const completion1 = firstTry.success
    const verdict1 = judgeCompletion(completion1, planned.lineCount)
    if (verdict1._tag === "Valid") {
      return yield* save(verdict1.enrichment, completion1.usage)
    }

    const second = retryRequest(first, completion1, verdict1)
    if (second === null) {
      return failed(verdict1.kind, verdict1.message, completion1.usage)
    }
    const secondTry = yield* ask(second)
    if (Result.isFailure(secondTry)) {
      return failed("api_error", secondTry.failure.message, completion1.usage)
    }
    const completion2 = secondTry.success
    const usage = addUsage(completion1.usage, completion2.usage)
    const verdict2 = judgeCompletion(completion2, planned.lineCount)
    return verdict2._tag === "Valid"
      ? yield* save(verdict2.enrichment, usage)
      : failed(verdict2.kind, verdict2.message, usage)
  })

/** Sync mode: concurrency 4 (spec A5). Each answer is stored when it arrives. */
const processSync = (
  model: ModelName,
  planned: ReadonlyArray<PlannedRecipe>,
  config: RunConfig
): Effect.Effect<ReadonlyArray<RecipeOutcome>, StoreError | LlmApiError, Llm | EnrichStore> =>
  Effect.gen(function* () {
    const done = yield* Ref.make(0)
    return yield* Effect.forEach(
      planned,
      (item) =>
        enrichOne(model, item).pipe(
          Effect.tap((outcome) =>
            Ref.updateAndGet(done, (count) => count + 1).pipe(
              Effect.flatMap((k) => Console.log(formatOutcomeLine({ k, n: planned.length, outcome })))
            )
          )
        ),
      { concurrency: config.concurrency }
    )
  })

/**
 * The outcome of one result line of a batch. A batch has no second attempt (spec A9).
 * `enrichment` is `Some` for a valid answer. The caller stores it.
 */
export const outcomeOfBatchItem = (
  item: BatchItem,
  recipe: BatchState["recipes"][number]
): {
  readonly outcome: RecipeOutcome
  readonly enrichment: Option.Option<Enrichment>
} => {
  const { id } = recipe
  const failed = (kind: FailureKind, message: string, usage: TokenUsage) => ({
    outcome: {
      _tag: "Failed",
      id,
      kind,
      message,
      usage,
    } satisfies RecipeOutcome,
    enrichment: Option.none<Enrichment>(),
  })
  switch (item.outcome._tag) {
    case "Succeeded": {
      const { completion } = item.outcome
      const verdict = judgeCompletion(completion, recipe.lineCount)
      return verdict._tag === "Valid"
        ? {
            outcome: { _tag: "Stored", id, usage: completion.usage },
            enrichment: Option.some(verdict.enrichment),
          }
        : failed(verdict.kind, verdict.message, completion.usage)
    }
    case "Errored":
      return failed("api_error", `${item.outcome.errorType}: ${item.outcome.message}`, NO_USAGE)
    case "Canceled":
      return failed("batch_canceled", "The batch canceled the request", NO_USAGE)
    case "Expired":
      return failed("batch_expired", "The request expired before the batch processed it", NO_USAGE)
  }
}

const describeBatch = (info: BatchInfo): string =>
  `batch ${info.id}: ${info.status}; processing ${info.processing}, succeeded ${info.succeeded}, ` +
  `errored ${info.errored}, canceled ${info.canceled}, expired ${info.expired}`

/** Poll the batch until it has ended. The waits grow (spec A5). */
const awaitBatch = (batchId: string, poll: PollConfig): Effect.Effect<BatchInfo, LlmApiError, Llm> =>
  Effect.gen(function* () {
    const llm = yield* Llm
    for (let attempt = 0; ; attempt += 1) {
      const info = yield* llm.getBatch(batchId)
      yield* Console.log(describeBatch(info))
      if (info.status === "ended") {
        return info
      }
      yield* Effect.sleep(pollDelayMs(poll, attempt))
    }
  })

/**
 * Wait for a batch, read its results, store the valid enrichments and remove `_batch.json`.
 * The same code runs after a new batch and after the resume of an old one.
 */
const finishBatch = (
  state: BatchState,
  parts: {
    readonly poll: PollConfig
    readonly retryFailed: boolean
    readonly outOfScope: number
    readonly cached: number
    readonly deferred: number
    readonly unreadable: ReadonlyArray<EnrichFailure>
  }
): Effect.Effect<EnrichReport, StoreError | LlmApiError, Llm | EnrichStore> =>
  Effect.gen(function* () {
    const llm = yield* Llm
    const store = yield* EnrichStore
    yield* awaitBatch(state.batchId, parts.poll)

    const byCustomId = new Map(state.recipes.map((recipe) => [customIdOf(recipe.id), recipe] as const))
    const outcomes = new Map<RecipeId, RecipeOutcome>()
    const total = state.recipes.length

    yield* llm.batchResults(state.batchId).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          const recipe = byCustomId.get(item.customId)
          if (recipe === undefined) {
            yield* Console.warn(`warning: the batch has a result for the unknown request ${item.customId}`)
            return
          }
          if (outcomes.has(recipe.id)) {
            return
          }
          const { outcome, enrichment } = outcomeOfBatchItem(item, recipe)
          if (Option.isSome(enrichment)) {
            const createdAt = yield* nowIso
            yield* Effect.uninterruptible(
              store.writeEnriched(
                storedRecipe({
                  id: recipe.id,
                  model: state.model,
                  promptVersion: state.promptVersion,
                  inputHash: recipe.inputHash,
                  createdAt,
                  usage: outcome.usage,
                  enrichment: enrichment.value,
                })
              )
            )
          }
          outcomes.set(recipe.id, outcome)
          yield* Console.log(formatOutcomeLine({ k: outcomes.size, n: total, outcome }))
        })
      )
    )

    const all: Array<RecipeOutcome> = []
    for (const recipe of state.recipes) {
      all.push(
        outcomes.get(recipe.id) ?? {
          _tag: "Failed",
          id: recipe.id,
          kind: "batch_missing",
          message: "The results of the batch have no line for this recipe",
          usage: NO_USAGE,
        }
      )
    }
    const report = buildReport({
      generatedAt: yield* nowIso,
      model: state.model,
      promptVersion: state.promptVersion,
      mode: "batch",
      retryFailed: parts.retryFailed,
      batchId: state.batchId,
      outOfScope: parts.outOfScope,
      cached: parts.cached,
      deferred: parts.deferred,
      unreadable: parts.unreadable,
      outcomes: all,
    })
    // The report goes first. If the run stops now, the next run reads the results again and stores the same files.
    yield* store.writeReport(report)
    yield* store.removeBatch
    return report
  })

/** Send the recipes as one batch and keep the batch ID in `_batch.json` (spec A5). */
const submitBatch = (
  model: ModelName,
  planned: ReadonlyArray<PlannedRecipe>
): Effect.Effect<BatchState, StoreError | LlmApiError, Llm | EnrichStore> =>
  Effect.gen(function* () {
    const llm = yield* Llm
    const store = yield* EnrichStore
    const info = yield* llm.createBatch(
      planned.map((item) => ({
        customId: customIdOf(item.id),
        request: requestFor(model, item),
      }))
    )
    const state: BatchState = {
      version: 1,
      batchId: info.id,
      model,
      promptVersion: PROMPT_VERSION,
      createdAt: yield* nowIso,
      recipes: planned.map((item) => ({
        id: item.id,
        inputHash: item.inputHash,
        lineCount: item.lineCount,
      })),
    }
    yield* Effect.uninterruptible(store.writeBatch(state))
    yield* Console.log(`batch ${info.id} created with ${planned.length} requests; the ID is in _batch.json`)
    return state
  })

export interface EnrichOutcome {
  readonly report: EnrichReport
}

/**
 * The enrichment run (spec P3).
 *
 * 1. If `_batch.json` exists, wait for that batch and store its results. Nothing else happens in this run.
 * 2. Otherwise select the recipes, skip the cached ones, and use sync mode or batch mode (spec A5).
 * 3. Write `_report.json`.
 */
export const enrichAll = (
  options: EnrichOptions,
  config: RunConfig = defaultRunConfig
): Effect.Effect<EnrichOutcome, EnrichError, Llm | EnrichStore> =>
  Effect.gen(function* () {
    const store = yield* EnrichStore
    yield* store.prepare

    const pending = yield* store.readBatch
    if (Option.isSome(pending)) {
      const state = pending.value
      if (state.model !== options.model) {
        return yield* new EnrichRunError({
          message:
            `A batch ${state.batchId} for the model ${state.model} waits in the output directory. ` +
            `Run again with --model ${state.model}, or move _batch.json away.`,
        })
      }
      yield* Console.log(
        `resume: batch ${state.batchId} with ${state.recipes.length} recipes; the other flags are not used`
      )
      const report = yield* finishBatch(state, {
        poll: config.poll,
        retryFailed: false,
        outOfScope: 0,
        cached: 0,
        deferred: 0,
        unreadable: [],
      })
      yield* Console.log(`done: ${formatTotals(report)}`)
      yield* Console.log(formatUsage(report))
      return { report }
    }

    const { plan, unreadable } = yield* gatherWork(options)
    const mode: RunMode = chooseMode({
      count: plan.toProcess.length,
      sync: options.sync,
      retryFailed: options.retryFailed,
    })
    yield* Console.log(
      `${plan.cached.length + plan.toProcess.length + plan.deferred} recipes selected: ${plan.cached.length} cached, ` +
        `${plan.toProcess.length} to process in ${mode} mode` +
        (plan.deferred > 0 ? `, ${plan.deferred} more after --limit` : "")
    )

    const common = {
      model: options.model,
      promptVersion: PROMPT_VERSION,
      retryFailed: options.retryFailed,
      outOfScope: plan.outOfScope.length,
      cached: plan.cached.length,
      deferred: plan.deferred,
      unreadable,
    }

    if (plan.toProcess.length > 0 && mode === "batch") {
      const state = yield* submitBatch(options.model, plan.toProcess)
      const report = yield* finishBatch(state, { ...common, poll: config.poll })
      yield* Console.log(`done: ${formatTotals(report)}`)
      yield* Console.log(formatUsage(report))
      return { report }
    }

    const outcomes = yield* processSync(options.model, plan.toProcess, config)
    const report = buildReport({
      ...common,
      generatedAt: yield* nowIso,
      mode: "sync",
      batchId: null,
      outcomes,
    })
    yield* store.writeReport(report)
    yield* Console.log(`done: ${formatTotals(report)}`)
    yield* Console.log(formatUsage(report))
    return { report }
  })
