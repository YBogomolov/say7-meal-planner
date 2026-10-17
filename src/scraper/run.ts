import { Clock, Console, DateTime, Effect, Option, Ref, Schema } from "effect"
import type { RawIndex } from "../domain/raw-index.ts"
import type { RecipeId, SitemapEntry } from "../domain/recipe.ts"
import { CharsetError, DEFAULT_PAGE_CHARSET, decodeText, detectCharset } from "./charset.ts"
import { describeFailure, Http, USER_AGENT } from "./http.ts"
import { classifyResult, toIndexEntry } from "./outcome.ts"
import { Pacer } from "./pacer.ts"
import { planFetches } from "./plan.ts"
import type { PlannedFetch } from "./plan.ts"
import { isAllowed, parseRobots } from "./robots.ts"
import { parseSitemap, recipePath, SitemapError } from "./sitemap.ts"
import { RawStore } from "./store.ts"
import type { IndexInvalidError, StoreError } from "./store.ts"

export class RobotsError extends Schema.TaggedError<RobotsError>()("RobotsError", {
  message: Schema.String,
}) {}

/** Pages in a row with status `error` after which the run stops. A `ok` or `not_found` page resets the count. */
export const MAX_CONSECUTIVE_ERRORS = 5

/** The run stopped because `MAX_CONSECUTIVE_ERRORS` pages in a row ended with status `error`. */
export class CircuitBreakerError extends Schema.TaggedError<CircuitBreakerError>()("CircuitBreakerError", {
  message: Schema.String,
}) {}

/** robots.txt or sitemap.xml could not be read. */
export class SourceError extends Schema.TaggedError<SourceError>()("SourceError", {
  url: Schema.String,
  message: Schema.String,
}) {}

export type ScrapeError =
  RobotsError | SourceError | SitemapError | CharsetError | StoreError | IndexInvalidError | CircuitBreakerError

export interface ScrapeOptions {
  /** Origin of the site without a trailing slash, for example `https://www.say7.info`. */
  readonly baseUrl: string
  /** Process only the first n entries that need a fetch. */
  readonly limit: Option.Option<number>
  /** Process only these recipe IDs. */
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
  /** Fetch again, also if the cache is current. */
  readonly force: boolean
}

export interface ScrapeSummary {
  readonly fetched: number
  readonly skipped: number
  readonly notFound: number
  readonly errors: number
  /** Entries that need a fetch but fell outside `limit`. */
  readonly deferred: number
}

interface Counts {
  readonly fetched: number
  readonly notFound: number
  readonly errors: number
}

/** `[k/n] <id> <status> <size KB> <ms>` (spec P1.10). The size is `-` when there is no body. */
export const formatPageLine = (line: {
  readonly k: number
  readonly n: number
  readonly id: RecipeId
  readonly status: "ok" | "not_found" | "error"
  readonly bytes: Option.Option<number>
  readonly ms: number
  readonly note: Option.Option<string>
}): string => {
  const size = Option.match(line.bytes, {
    onNone: () => "-",
    onSome: (bytes) => `${(bytes / 1024).toFixed(1)} KB`,
  })
  const note = Option.match(line.note, {
    onNone: () => "",
    onSome: (text) => ` (${text})`,
  })
  return `[${line.k}/${line.n}] ${line.id} ${line.status} ${size} ${line.ms} ms${note}`
}

export const formatTotals = (summary: ScrapeSummary): string => {
  const base = `fetched ${summary.fetched}, skipped ${summary.skipped}, not found ${summary.notFound}, errors ${summary.errors}`
  return summary.deferred > 0 ? `${base}, not processed because of --limit ${summary.deferred}` : base
}

/** Download robots.txt, the sitemap and then every recipe page that the cache does not cover. */
export const scrape = (options: ScrapeOptions): Effect.Effect<ScrapeSummary, ScrapeError, Http | Pacer | RawStore> =>
  Effect.gen(function* () {
    const http = yield* Http
    const pacer = yield* Pacer
    const store = yield* RawStore

    // The default page charset must work before the first request.
    yield* Effect.fromResult(
      detectCharset(new Uint8Array(), {
        contentType: Option.none(),
        defaultLabel: DEFAULT_PAGE_CHARSET,
        sniffMeta: false,
      })
    )

    const contents = yield* store.load

    const fetchText = (url: string) =>
      pacer.paced(http.get(url)).pipe(
        Effect.mapError((failure) => new SourceError({ url, message: describeFailure(failure) })),
        Effect.flatMap((response) =>
          Effect.fromResult(
            decodeText(response.body, {
              contentType: response.contentType,
              defaultLabel: "utf-8",
              sniffMeta: false,
            })
          )
        ),
        Effect.map((decoded) => decoded.text)
      )

    const robots = parseRobots(yield* fetchText(`${options.baseUrl}/robots.txt`))
    const sitemapText = yield* fetchText(`${options.baseUrl}/sitemap.xml`)
    const entries = yield* Effect.fromResult(parseSitemap(sitemapText))
    if (entries.length === 0) {
      return yield* new SitemapError({
        message: "The sitemap has no recipe URLs",
      })
    }

    const blocked = entries.find((entry) => !isAllowed(robots, USER_AGENT, recipePath(entry)))
    if (blocked !== undefined) {
      return yield* new RobotsError({
        message: `robots.txt disallows ${recipePath(blocked)} for ${USER_AGENT}. The scraper stops.`,
      })
    }

    const plan = planFetches({
      entries,
      index: contents.index,
      existingFiles: contents.pageIds,
      force: options.force,
      ids: options.ids,
      limit: options.limit,
    })
    if (plan.unknownIds.length > 0) {
      yield* Console.warn(`warning: IDs not in the sitemap: ${plan.unknownIds.join(", ")}`)
    }
    yield* Console.log(
      `sitemap: ${entries.length} recipes; ${plan.toFetch.length} to fetch, ${plan.skipped} up to date` +
        (plan.deferred > 0 ? `, ${plan.deferred} more after --limit` : "")
    )

    const indexRef = yield* Ref.make<RawIndex>(contents.index)
    const countsRef = yield* Ref.make<Counts>({
      fetched: 0,
      notFound: 0,
      errors: 0,
    })
    const errorStreakRef = yield* Ref.make(0)
    const summary = Effect.map(Ref.get(countsRef), (counts): ScrapeSummary => ({
      ...counts,
      skipped: plan.skipped,
      deferred: plan.deferred,
    }))

    /** One request, timed without the wait of the pacer. */
    const timedGet = (entry: SitemapEntry) =>
      pacer.paced(
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis
          const result = yield* Effect.result(http.get(`${options.baseUrl}${recipePath(entry)}`))
          const finished = yield* Clock.currentTimeMillis
          return { result, ms: finished - started }
        })
      )

    const processPage = (planned: PlannedFetch, k: number) =>
      Effect.gen(function* () {
        const { entry } = planned
        const { result, ms } = yield* timedGet(entry)
        const { outcome, page } = classifyResult(result)

        const html = Option.isSome(page)
          ? Option.some(
              yield* Effect.fromResult(
                decodeText(page.value.body, {
                  contentType: page.value.contentType,
                  defaultLabel: DEFAULT_PAGE_CHARSET,
                  sniffMeta: true,
                })
              )
            )
          : Option.none()

        const fetchedAt = DateTime.formatIso(yield* DateTime.now)
        const previous = Option.fromNullishOr((yield* Ref.get(indexRef)).entries[String(entry.id)])
        const indexEntry = toIndexEntry(entry, previous, contents.pageIds.has(entry.id), outcome, fetchedAt)

        // The page file and the index are written together. Ctrl+C waits until both are on disk.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (Option.isSome(html)) {
              yield* store.savePage(entry.id, html.value.text)
            }
            const index = yield* Ref.updateAndGet(indexRef, (current): RawIndex => ({
              version: 1,
              entries: { ...current.entries, [String(entry.id)]: indexEntry },
            }))
            yield* store.saveIndex(index)
          })
        )

        yield* Ref.update(countsRef, (counts): Counts => {
          switch (outcome._tag) {
            case "Fetched":
              return { ...counts, fetched: counts.fetched + 1 }
            case "NotFound":
              return { ...counts, notFound: counts.notFound + 1 }
            case "Failed":
              return { ...counts, errors: counts.errors + 1 }
          }
        })

        yield* Console.log(
          formatPageLine({
            k,
            n: plan.toFetch.length,
            id: entry.id,
            status: outcome._tag === "Fetched" ? "ok" : outcome._tag === "NotFound" ? "not_found" : "error",
            bytes: outcome._tag === "Fetched" ? Option.some(outcome.bytes) : Option.none(),
            ms,
            note: outcome._tag === "Failed" ? Option.some(outcome.message) : Option.none(),
          })
        )

        const streak = yield* Ref.updateAndGet(errorStreakRef, (count) => (outcome._tag === "Failed" ? count + 1 : 0))
        if (streak >= MAX_CONSECUTIVE_ERRORS) {
          return yield* new CircuitBreakerError({
            message:
              `${streak} pages in a row ended with status error. The site can be down or can block the scraper. ` +
              `The scraper stops. Wait, then run the command again.`,
          })
        }
      })

    yield* Effect.forEach(plan.toFetch, (planned, position) => processPage(planned, position + 1), {
      discard: true,
    }).pipe(Effect.ensuring(Effect.flatMap(summary, (totals) => Console.log(`done: ${formatTotals(totals)}`))))

    return yield* summary
  })
