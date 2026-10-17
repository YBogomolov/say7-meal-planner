import { Clock, Context, Effect, Layer, Option, Random, Ref } from "effect"

/** Share of the base delay that the random jitter adds or removes: 2500 ms gives 2000 to 3000 ms (D4). */
export const JITTER = 0.2

/** Delay for a random `unit` in [0, 1): from `base * (1 - JITTER)` up to `base * (1 + JITTER)`. */
export const jitteredDelayMs = (baseMs: number, unit: number): number =>
  Math.round(baseMs * (1 - JITTER + 2 * JITTER * unit))

/**
 * Keeps the gap between requests (D4). The wait starts when the previous request ends.
 * The first request has no wait.
 */
export class Pacer extends Context.Service<
  Pacer,
  {
    readonly paced: <A, E, R>(request: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  }
>()("say7/scraper/Pacer") {
  static readonly layer = (baseDelayMs: number): Layer.Layer<Pacer> =>
    Layer.effect(
      Pacer,
      Effect.gen(function* () {
        const lastEnd = yield* Ref.make(Option.none<number>())

        const markEnd = Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(lastEnd, Option.some(now))))

        const waitForTurn = Effect.gen(function* () {
          const last = yield* Ref.get(lastEnd)
          if (Option.isNone(last)) {
            return
          }
          const unit = yield* Random.next
          const now = yield* Clock.currentTimeMillis
          const wait = last.value + jitteredDelayMs(baseDelayMs, unit) - now
          if (wait > 0) {
            yield* Effect.sleep(wait)
          }
        })

        return Pacer.of({
          paced: (request) => waitForTurn.pipe(Effect.andThen(request), Effect.ensuring(markEnd)),
        })
      })
    )
}
