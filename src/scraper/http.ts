import { Clock, Console, Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"

/** User-Agent header of every request (spec P1.9). */
export const USER_AGENT = "say7-meal-planner/0.1 (personal non-commercial use)"

/** Retries after the first attempt (spec P1.5). */
export const MAX_RETRIES = 3

/** Upper limit for a `Retry-After` wait. A longer wait counts as the limit. */
export const MAX_RETRY_AFTER = Duration.minutes(2)

export class NetworkError extends Schema.TaggedError<NetworkError>()("NetworkError", {
  url: Schema.String,
  reason: Schema.Literals(["timeout", "connection", "redirect"]),
  message: Schema.String,
}) {}

export class HttpStatusError extends Schema.TaggedError<HttpStatusError>()("HttpStatusError", {
  url: Schema.String,
  status: Schema.Int,
  /** Wait time from the `Retry-After` header. Only read for 429 and 503. */
  retryAfter: Schema.Option(Schema.Natural),
}) {}

export type HttpFailure = NetworkError | HttpStatusError

export interface HttpResponse {
  readonly url: string
  readonly status: number
  readonly contentType: Option.Option<string>
  readonly body: Uint8Array
}

export interface HttpConfig {
  readonly userAgent: string
  /** Time limit for one attempt, from the request to the last byte of the body. */
  readonly timeout: Duration.Input
  /** First retry delay. Later delays double: 2 s, 4 s, 8 s. */
  readonly retryBase: Duration.Input
}

export const defaultHttpConfig: HttpConfig = {
  userAgent: USER_AGENT,
  timeout: Duration.seconds(30),
  retryBase: Duration.seconds(2),
}

/** Short text for the log and for `RawIndexEntry.error`. */
export const describeFailure = (failure: HttpFailure): string =>
  failure._tag === "HttpStatusError" ? `HTTP ${failure.status}` : failure.message

/**
 * Parse a `Retry-After` header value into milliseconds.
 * The value is a number of seconds or an HTTP date such as `Mon, 12 Oct 2026 10:00:30 GMT`.
 * Return `None` for anything else.
 */
export const parseRetryAfter = (value: string, nowMs: number): Option.Option<number> => {
  const text = value.trim()
  if (/^\d+$/.test(text)) {
    return Option.some(Number(text) * 1000)
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    return Option.none()
  }
  const at = Date.parse(text)
  return Number.isNaN(at) ? Option.none() : Option.some(Math.max(0, at - nowMs))
}

/** Retry on network errors, 429 and 5xx. Never retry 404 or other 4xx (spec P1.5). */
export const isRetryable = (failure: HttpFailure): boolean =>
  failure._tag === "NetworkError"
    ? failure.reason !== "redirect"
    : failure.status === 429 || (failure.status >= 500 && failure.status <= 599)

/** Wait before a retry: the backoff, or the `Retry-After` value if that is longer (up to `MAX_RETRY_AFTER`). */
export const retryDelay = (backoff: Duration.Duration, failure: HttpFailure): Duration.Duration => {
  if (failure._tag === "NetworkError" || Option.isNone(failure.retryAfter)) {
    return backoff
  }
  return Duration.max(backoff, Duration.min(Duration.millis(failure.retryAfter.value), MAX_RETRY_AFTER))
}

/** Retry policy of spec P1.5: 3 retries after 2 s, 4 s, 8 s; `Retry-After` can lengthen a wait. */
export const retrySchedule = (base: Duration.Input) =>
  Schedule.exponential(base).pipe(
    Schedule.setInputType<HttpFailure>(),
    Schedule.while(({ input }) => isRetryable(input)),
    Schedule.upTo({ times: MAX_RETRIES }),
    Schedule.modifyDelay(({ duration, input }) => Effect.succeed(retryDelay(duration, input))),
    Schedule.tap(({ attempt, duration, input }) =>
      Console.warn(`retry ${attempt}/${MAX_RETRIES} in ${Duration.toMillis(duration)} ms: ${describeFailure(input)}`)
    )
  )

type RawResponse =
  | {
      readonly _tag: "Received"
      readonly status: number
      readonly ok: boolean
      readonly contentType: string | null
      readonly retryAfter: string | null
      readonly body: Uint8Array
    }
  | { readonly _tag: "OffOrigin"; readonly finalUrl: string }

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    const inner = cause.cause
    return inner instanceof Error ? `${cause.message}: ${inner.message}` : cause.message
  }
  return String(cause)
}

/** One HTTP attempt: the request, the whole body, and the time limit. */
const attempt = (config: HttpConfig, url: string): Effect.Effect<HttpResponse, HttpFailure> =>
  Effect.tryPromise({
    try: async (signal): Promise<RawResponse> => {
      const response = await fetch(url, {
        signal,
        headers: { "user-agent": config.userAgent },
      })
      if (new URL(response.url).origin !== new URL(url).origin) {
        await response.body?.cancel()
        return { _tag: "OffOrigin", finalUrl: response.url }
      }
      const contentType = response.headers.get("content-type")
      const retryAfter = response.headers.get("retry-after")
      if (!response.ok) {
        await response.body?.cancel()
        return {
          _tag: "Received",
          status: response.status,
          ok: false,
          contentType,
          retryAfter,
          body: new Uint8Array(),
        }
      }
      const body = new Uint8Array(await response.arrayBuffer())
      return {
        _tag: "Received",
        status: response.status,
        ok: true,
        contentType,
        retryAfter,
        body,
      }
    },
    catch: (cause) =>
      new NetworkError({
        url,
        reason: "connection",
        message: `Request failed: ${describeCause(cause)}`,
      }),
  }).pipe(
    Effect.timeout(config.timeout),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new NetworkError({
          url,
          reason: "timeout",
          message: `Timeout after ${Duration.toMillis(Duration.fromInputUnsafe(config.timeout))} ms`,
        })
      )
    ),
    Effect.flatMap((raw): Effect.Effect<HttpResponse, HttpFailure> => {
      if (raw._tag === "OffOrigin") {
        return Effect.fail(
          new NetworkError({
            url,
            reason: "redirect",
            message: `Redirect to another origin: ${raw.finalUrl}`,
          })
        )
      }
      if (raw.ok) {
        return Effect.succeed<HttpResponse>({
          url,
          status: raw.status,
          contentType: Option.fromNullishOr(raw.contentType),
          body: raw.body,
        })
      }
      return Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const honourRetryAfter = raw.status === 429 || raw.status === 503
          const retryAfter = honourRetryAfter
            ? Option.fromNullishOr(raw.retryAfter).pipe(Option.flatMap((value) => parseRetryAfter(value, now)))
            : Option.none()
          return Effect.fail(new HttpStatusError({ url, status: raw.status, retryAfter }))
        })
      )
    })
  )

/**
 * HTTP GET with a time limit and the retry policy of the spec.
 * Succeeds only for 2xx. Every other status fails with `HttpStatusError`.
 */
export class Http extends Context.Service<
  Http,
  {
    readonly get: (url: string) => Effect.Effect<HttpResponse, HttpFailure>
  }
>()("say7/scraper/Http") {
  static readonly layer = (config: HttpConfig = defaultHttpConfig): Layer.Layer<Http> =>
    Layer.succeed(
      Http,
      Http.of({
        get: (url) => attempt(config, url).pipe(Effect.retry(retrySchedule(config.retryBase))),
      })
    )
}
