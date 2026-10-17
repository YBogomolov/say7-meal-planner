import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Exit, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  defaultHttpConfig,
  Http,
  HttpStatusError,
  isRetryable,
  MAX_RETRIES,
  MAX_RETRY_AFTER,
  NetworkError,
  parseRetryAfter,
  retryDelay,
  retrySchedule,
  USER_AGENT,
} from "../src/scraper/http.ts"
import type { HttpFailure } from "../src/scraper/http.ts"
import { startTestSite } from "./support/site.ts"

const status = (code: number, retryAfterMs: number | null = null) =>
  new HttpStatusError({
    url: "http://x/",
    status: code,
    retryAfter: Option.fromNullishOr(retryAfterMs),
  })

const network = (reason: "timeout" | "connection" | "redirect") =>
  new NetworkError({ url: "http://x/", reason, message: reason })

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-12T10:00:00Z")

  it("reads a number of seconds", () => {
    assert.strictEqual(Option.getOrNull(parseRetryAfter("120", now)), 120_000)
    assert.strictEqual(Option.getOrNull(parseRetryAfter(" 0 ", now)), 0)
  })

  it("reads an HTTP date", () => {
    assert.strictEqual(Option.getOrNull(parseRetryAfter("Mon, 12 Oct 2026 10:00:30 GMT", now)), 30_000)
  })

  it("gives zero for a date in the past", () => {
    assert.strictEqual(Option.getOrNull(parseRetryAfter("Mon, 12 Oct 2026 09:00:00 GMT", now)), 0)
  })

  it("returns None for text that is neither", () => {
    assert.isTrue(Option.isNone(parseRetryAfter("soon", now)))
    assert.isTrue(Option.isNone(parseRetryAfter("-5", now)))
    assert.isTrue(Option.isNone(parseRetryAfter("", now)))
  })
})

describe("isRetryable", () => {
  it.each([429, 500, 502, 503, 504, 599])("retries HTTP %s", (code) => {
    assert.isTrue(isRetryable(status(code)))
  })

  it.each([400, 401, 403, 404, 410])("does not retry HTTP %s", (code) => {
    assert.isFalse(isRetryable(status(code)))
  })

  it("retries time-outs and connection errors but not redirects to another origin", () => {
    assert.isTrue(isRetryable(network("timeout")))
    assert.isTrue(isRetryable(network("connection")))
    assert.isFalse(isRetryable(network("redirect")))
  })
})

describe("retryDelay", () => {
  const backoff = Duration.seconds(2)

  it("uses the backoff when there is no Retry-After", () => {
    assert.strictEqual(Duration.toMillis(retryDelay(backoff, status(503))), 2000)
    assert.strictEqual(Duration.toMillis(retryDelay(backoff, network("timeout"))), 2000)
  })

  it("uses Retry-After when it is longer than the backoff", () => {
    assert.strictEqual(Duration.toMillis(retryDelay(backoff, status(429, 30_000))), 30_000)
  })

  it("keeps the backoff when Retry-After is shorter", () => {
    assert.strictEqual(Duration.toMillis(retryDelay(backoff, status(503, 500))), 2000)
  })

  it("caps a long Retry-After", () => {
    assert.strictEqual(
      Duration.toMillis(retryDelay(backoff, status(503, 3_600_000))),
      Duration.toMillis(MAX_RETRY_AFTER)
    )
  })
})

describe("retrySchedule", () => {
  /** An effect that fails with `failure` and counts its attempts. */
  const failing = (failure: HttpFailure) => {
    const counter = { attempts: 0 }
    const effect = Effect.suspend(() => {
      counter.attempts += 1
      return Effect.fail(failure)
    })
    return { counter, effect }
  }

  it.effect("retries 3 times, after 2 s, 4 s and 8 s", () =>
    Effect.gen(function* () {
      const { counter, effect } = failing(status(503))
      const fiber = yield* Effect.forkChild(Effect.exit(effect.pipe(Effect.retry(retrySchedule("2 seconds")))))
      yield* Effect.yieldNow
      assert.strictEqual(counter.attempts, 1)

      yield* TestClock.adjust(1999)
      assert.strictEqual(counter.attempts, 1)
      yield* TestClock.adjust(1)
      assert.strictEqual(counter.attempts, 2)

      yield* TestClock.adjust(3999)
      assert.strictEqual(counter.attempts, 2)
      yield* TestClock.adjust(1)
      assert.strictEqual(counter.attempts, 3)

      yield* TestClock.adjust(7999)
      assert.strictEqual(counter.attempts, 3)
      yield* TestClock.adjust(1)
      assert.strictEqual(counter.attempts, 4)

      const exit = yield* Fiber.join(fiber)
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(counter.attempts, 1 + MAX_RETRIES)
      yield* TestClock.adjust(60_000)
      assert.strictEqual(counter.attempts, 1 + MAX_RETRIES)
    })
  )

  it.effect("does not retry a 404", () =>
    Effect.gen(function* () {
      const { counter, effect } = failing(status(404))
      const exit = yield* Effect.exit(effect.pipe(Effect.retry(retrySchedule("2 seconds"))))
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(counter.attempts, 1)
    })
  )

  it.effect("waits for Retry-After when it is longer than the backoff", () =>
    Effect.gen(function* () {
      const { counter, effect } = failing(status(429, 20_000))
      yield* Effect.forkChild(Effect.exit(effect.pipe(Effect.retry(retrySchedule("2 seconds")))))
      yield* Effect.yieldNow
      yield* TestClock.adjust(19_999)
      assert.strictEqual(counter.attempts, 1)
      yield* TestClock.adjust(1)
      assert.strictEqual(counter.attempts, 2)
    })
  )

  it.effect("returns the value of a later success", () =>
    Effect.gen(function* () {
      const counter = { attempts: 0 }
      const flaky = Effect.suspend(() => {
        counter.attempts += 1
        return counter.attempts < 3 ? Effect.fail(status(500)) : Effect.succeed("page")
      })
      const fiber = yield* Effect.forkChild(flaky.pipe(Effect.retry(retrySchedule("2 seconds"))))
      yield* Effect.yieldNow
      yield* TestClock.adjust(2000)
      yield* TestClock.adjust(4000)
      assert.strictEqual(yield* Fiber.join(fiber), "page")
      assert.strictEqual(counter.attempts, 3)
    })
  )
})

describe("Http against a local server", () => {
  const fastConfig = {
    userAgent: USER_AGENT,
    timeout: Duration.millis(400),
    retryBase: Duration.millis(5),
  }

  it.live("returns the body, the content type and sends the User-Agent", () =>
    Effect.gen(function* () {
      const site = yield* startTestSite
      site.route("/ok", () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=windows-1251" },
        body: "abc",
      }))
      const response = yield* Http.use((http) => http.get(`${site.origin}/ok`)).pipe(
        Effect.provide(Http.layer(fastConfig))
      )
      assert.strictEqual(response.status, 200)
      assert.strictEqual(Option.getOrNull(response.contentType), "text/html; charset=windows-1251")
      assert.strictEqual(new TextDecoder().decode(response.body), "abc")
      assert.strictEqual(site.requests[0]?.userAgent, "say7-meal-planner/0.1 (personal non-commercial use)")
    })
  )

  it.live("fails with HttpStatusError for 404 and does not retry", () =>
    Effect.gen(function* () {
      const site = yield* startTestSite
      const error = yield* Http.use((http) => http.get(`${site.origin}/missing`)).pipe(
        Effect.provide(Http.layer(fastConfig)),
        Effect.flip
      )
      assert.strictEqual(error._tag, "HttpStatusError")
      assert.strictEqual(error._tag === "HttpStatusError" ? error.status : 0, 404)
      assert.strictEqual(site.hits("/missing"), 1)
    })
  )

  it.live("reads Retry-After from 429 and 503 only", () =>
    Effect.gen(function* () {
      const site = yield* startTestSite
      site.route("/limited", () => ({
        status: 429,
        headers: { "retry-after": "0" },
      }))
      site.route("/teapot", () => ({
        status: 418,
        headers: { "retry-after": "7" },
      }))
      const run = (path: string) =>
        Http.use((http) => http.get(`${site.origin}${path}`)).pipe(Effect.provide(Http.layer(fastConfig)), Effect.flip)
      const limited = yield* run("/limited")
      const teapot = yield* run("/teapot")
      assert.strictEqual(limited._tag === "HttpStatusError" ? Option.getOrNull(limited.retryAfter) : null, 0)
      assert.strictEqual(teapot._tag === "HttpStatusError" ? Option.getOrNull(teapot.retryAfter) : "x", null)
      assert.strictEqual(site.hits("/limited"), 1 + MAX_RETRIES)
      assert.strictEqual(site.hits("/teapot"), 1)
    })
  )

  it.live("retries a 503 and returns the later 200", () =>
    Effect.gen(function* () {
      const site = yield* startTestSite
      site.route("/flaky", (hit) => (hit < 3 ? { status: 503 } : { status: 200, body: "fine" }))
      const response = yield* Http.use((http) => http.get(`${site.origin}/flaky`)).pipe(
        Effect.provide(Http.layer(fastConfig))
      )
      assert.strictEqual(new TextDecoder().decode(response.body), "fine")
      assert.strictEqual(site.hits("/flaky"), 3)
    })
  )

  it.live("gives up after 3 retries", () =>
    Effect.gen(function* () {
      const site = yield* startTestSite
      site.route("/down", () => ({ status: 500 }))
      const error = yield* Http.use((http) => http.get(`${site.origin}/down`)).pipe(
        Effect.provide(Http.layer(fastConfig)),
        Effect.flip
      )
      assert.strictEqual(error._tag, "HttpStatusError")
      assert.strictEqual(site.hits("/down"), 4)
    })
  )

  it.live("times out and retries", () =>
    Effect.gen(function* () {
      const site = yield* startTestSite
      site.route("/slow", () => ({ status: 200, hang: true }))
      const error = yield* Http.use((http) => http.get(`${site.origin}/slow`)).pipe(
        Effect.provide(Http.layer({ ...fastConfig, timeout: Duration.millis(60) })),
        Effect.flip
      )
      assert.strictEqual(error._tag === "NetworkError" ? error.reason : null, "timeout")
      assert.strictEqual(site.hits("/slow"), 4)
    })
  )

  it.live("fails with NetworkError when nothing listens, and retries", () =>
    Effect.gen(function* () {
      const closedOrigin = yield* Effect.scoped(startTestSite.pipe(Effect.map((site) => site.origin)))
      const error = yield* Http.use((http) => http.get(`${closedOrigin}/x`)).pipe(
        Effect.provide(Http.layer(fastConfig)),
        Effect.flip
      )
      assert.strictEqual(error._tag === "NetworkError" ? error.reason : null, "connection")
    })
  )

  it.live("stops on a redirect to another origin", () =>
    Effect.gen(function* () {
      const other = yield* startTestSite
      other.route("/target", () => ({ status: 200, body: "elsewhere" }))
      const site = yield* startTestSite
      site.route("/jump", () => ({
        status: 302,
        headers: { location: `${other.origin}/target` },
      }))
      const error = yield* Http.use((http) => http.get(`${site.origin}/jump`)).pipe(
        Effect.provide(Http.layer(fastConfig)),
        Effect.flip
      )
      assert.strictEqual(error._tag === "NetworkError" ? error.reason : null, "redirect")
      assert.strictEqual(site.hits("/jump"), 1)
    })
  )

  it.live("follows a redirect inside the same origin", () =>
    Effect.gen(function* () {
      const site = yield* startTestSite
      site.route("/old", () => ({ status: 301, headers: { location: "/new" } }))
      site.route("/new", () => ({ status: 200, body: "moved" }))
      const response = yield* Http.use((http) => http.get(`${site.origin}/old`)).pipe(
        Effect.provide(Http.layer(fastConfig))
      )
      assert.strictEqual(new TextDecoder().decode(response.body), "moved")
    })
  )
})

describe("defaultHttpConfig", () => {
  it("has the timeout and the first retry delay of the spec", () => {
    assert.strictEqual(Duration.toMillis(Duration.fromInputUnsafe(defaultHttpConfig.timeout)), 30_000)
    assert.strictEqual(Duration.toMillis(Duration.fromInputUnsafe(defaultHttpConfig.retryBase)), 2_000)
    assert.strictEqual(MAX_RETRIES, 3)
  })
})
