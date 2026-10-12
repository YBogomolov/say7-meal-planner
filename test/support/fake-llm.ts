import { Effect, Layer, Ref, Stream } from "effect"
import { Llm } from "../../src/enrich/api.ts"
import { LlmApiError } from "../../src/enrich/llm-types.ts"
import type {
  BatchEntry,
  BatchInfo,
  BatchItem,
  BatchOutcome,
  LlmCompletion,
  LlmRequest
} from "../../src/enrich/llm-types.ts"
import type { Enrichment } from "../../src/domain/enriched-recipe.ts"

export const USAGE = { inputTokens: 1000, outputTokens: 800, cacheReadTokens: 3000, cacheCreationTokens: 0 } as const

/** A normal answer: the JSON of `enrichment`, `end_turn`. */
export const answer = (enrichment: Enrichment, usage = USAGE): LlmCompletion => ({
  text: JSON.stringify(enrichment),
  stopReason: "end_turn",
  usage
})

/** Any text with any stop reason. */
export const rawAnswer = (text: string, stopReason: string | null = "end_turn", usage = USAGE): LlmCompletion => ({
  text,
  stopReason,
  usage
})

export const apiError = (kind: LlmApiError["kind"], status: number | null = null, message = "boom"): LlmApiError =>
  new LlmApiError({ kind, status, message })

export type Reply = LlmCompletion | LlmApiError

export interface FakeBatchOptions {
  /** Number of polls that answer `in_progress` before the batch has ended. Default 1. */
  readonly pollsBeforeEnd?: number
  /** The result for one request. `"omit"` leaves the request out of the results file. */
  readonly reply: (entry: BatchEntry, position: number) => BatchOutcome | "omit"
  /** `createBatch` fails with this error. */
  readonly createError?: LlmApiError
}

export interface FakeLlmOptions {
  /** The answer to the n-th call of `complete`, counted from 0 over all recipes. */
  readonly complete?: (request: LlmRequest, call: number) => Reply
  /** Wait in each call of `complete`, to measure the concurrency. */
  readonly latencyMs?: number
  readonly batch?: FakeBatchOptions
}

export interface FakeLlm {
  readonly layer: Layer.Layer<Llm>
  /** Every request of `complete`, in the order of the calls. */
  readonly requests: Array<LlmRequest>
  /** Every batch that `createBatch` got. */
  readonly createdBatches: Array<ReadonlyArray<BatchEntry>>
  /** Number of calls of `getBatch`. */
  readonly polls: { count: number }
  /** The highest number of calls of `complete` that ran at the same time. */
  readonly maxInFlight: { value: number }
  readonly batchId: string
}

/** The `Llm` service without a network. It records the requests, so that a test can read them. */
export const makeFakeLlm = (options: FakeLlmOptions = {}): FakeLlm => {
  const requests: Array<LlmRequest> = []
  const createdBatches: Array<ReadonlyArray<BatchEntry>> = []
  const polls = { count: 0 }
  const maxInFlight = { value: 0 }
  const batchId = "msgbatch_fake_1"
  const inFlight = { value: 0 }

  const info = (entries: ReadonlyArray<BatchEntry>, ended: boolean): BatchInfo => ({
    id: batchId,
    status: ended ? "ended" : "in_progress",
    processing: ended ? 0 : entries.length,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0
  })

  const layer = Layer.effect(
    Llm,
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      return Llm.of({
        complete: (request) =>
          Effect.gen(function*() {
            const call = yield* Ref.getAndUpdate(calls, (n) => n + 1)
            requests.push(request)
            inFlight.value += 1
            maxInFlight.value = Math.max(maxInFlight.value, inFlight.value)
            if (options.latencyMs !== undefined) {
              yield* Effect.sleep(options.latencyMs)
            }
            inFlight.value -= 1
            const reply = options.complete === undefined
              ? apiError("other", null, "complete must not be called")
              : options.complete(request, call)
            return yield* (reply instanceof LlmApiError ? Effect.fail(reply) : Effect.succeed(reply))
          }),

        createBatch: (entries) => {
          if (options.batch?.createError !== undefined) {
            return Effect.fail(options.batch.createError)
          }
          createdBatches.push(entries)
          return Effect.succeed(info(entries, false))
        },

        getBatch: () =>
          Effect.sync(() => {
            polls.count += 1
            const entries = createdBatches.at(-1) ?? []
            return info(entries, polls.count > (options.batch?.pollsBeforeEnd ?? 1))
          }),

        batchResults: () =>
          Stream.fromIterable(
            (createdBatches.at(-1) ?? []).flatMap((entry, position): ReadonlyArray<BatchItem> => {
              const outcome = options.batch?.reply(entry, position)
              return outcome === undefined || outcome === "omit" ? [] : [{ customId: entry.customId, outcome }]
            })
          )
      })
    })
  )
  return { layer, requests, createdBatches, polls, maxInFlight, batchId }
}

/** `layer` for a batch that a test has not created itself: the results come from `reply` for the given entries. */
export const batchResultsOnly = (
  batchId: string,
  items: ReadonlyArray<BatchItem>,
  ended = true
): Layer.Layer<Llm> =>
  Layer.succeed(
    Llm,
    Llm.of({
      complete: () => Effect.fail(apiError("other", null, "complete must not be called")),
      createBatch: () => Effect.fail(apiError("other", null, "createBatch must not be called")),
      getBatch: () =>
        Effect.succeed({
          id: batchId,
          status: ended ? "ended" : "in_progress",
          processing: 0,
          succeeded: items.length,
          errored: 0,
          canceled: 0,
          expired: 0
        }),
      batchResults: () => Stream.fromIterable(items)
    })
  )
