import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { jitteredDelayMs, Pacer } from "../src/scraper/pacer.ts"

describe("jitteredDelayMs", () => {
  it("spreads 2500 ms over 2000 to 3000 ms (D4)", () => {
    assert.strictEqual(jitteredDelayMs(2500, 0), 2000)
    assert.strictEqual(jitteredDelayMs(2500, 0.5), 2500)
    assert.strictEqual(jitteredDelayMs(2500, 0.999999), 3000)
  })

  it("gives zero for a zero base", () => {
    assert.strictEqual(jitteredDelayMs(0, 0.7), 0)
  })

  it("stays inside the bounds for any random value", () => {
    for (let step = 0; step < 100; step += 1) {
      const delay = jitteredDelayMs(2500, step / 100)
      assert.isTrue(delay >= 2000 && delay <= 3000)
    }
  })
})

describe("Pacer", () => {
  it.effect("does not delay the first request", () =>
    Effect.gen(function* () {
      const pacer = yield* Pacer
      const started = yield* Clock.currentTimeMillis
      yield* pacer.paced(Effect.void)
      assert.strictEqual((yield* Clock.currentTimeMillis) - started, 0)
    }).pipe(Effect.provide(Pacer.layer(2500)))
  )

  it.effect("delays the next request by 2000 to 3000 ms after the previous one ends", () =>
    Effect.gen(function* () {
      const pacer = yield* Pacer
      const startTimes: Array<number> = []
      const request = Clock.currentTimeMillis.pipe(Effect.tap((now) => Effect.sync(() => startTimes.push(now))))

      yield* pacer.paced(request)
      const fiber = yield* Effect.forkChild(pacer.paced(request))
      yield* Effect.yieldNow
      yield* TestClock.adjust(1999)
      assert.strictEqual(startTimes.length, 1)
      yield* TestClock.adjust(1001)
      yield* Fiber.join(fiber)
      assert.strictEqual(startTimes.length, 2)
      const gap = (startTimes[1] ?? 0) - (startTimes[0] ?? 0)
      assert.isTrue(gap >= 2000 && gap <= 3000, `gap was ${gap} ms`)
    }).pipe(Effect.provide(Pacer.layer(2500)))
  )

  it.effect("counts the wait from the end of the previous request", () =>
    Effect.gen(function* () {
      const pacer = yield* Pacer
      yield* pacer.paced(Effect.void)
      // The previous request ends. A long pause follows that is longer than the maximum delay.
      yield* TestClock.adjust(10_000)
      const before = yield* Clock.currentTimeMillis
      yield* pacer.paced(Effect.void)
      assert.strictEqual((yield* Clock.currentTimeMillis) - before, 0)
    }).pipe(Effect.provide(Pacer.layer(2500)))
  )

  it.effect("does not wait with a zero delay", () =>
    Effect.gen(function* () {
      const pacer = yield* Pacer
      yield* pacer.paced(Effect.void)
      yield* pacer.paced(Effect.void)
      yield* pacer.paced(Effect.void)
      assert.strictEqual(yield* Clock.currentTimeMillis, 0)
    }).pipe(Effect.provide(Pacer.layer(0)))
  )
})
