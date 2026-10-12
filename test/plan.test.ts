import { assert, describe, it } from "@effect/vitest"
import { Option, Result, Schema } from "effect"
import type { RawIndex, RawIndexEntry } from "../src/domain/raw-index.ts"
import { RecipeId } from "../src/domain/recipe.ts"
import type { SitemapEntry } from "../src/domain/recipe.ts"
import { HttpStatusError, NetworkError } from "../src/scraper/http.ts"
import type { HttpResponse } from "../src/scraper/http.ts"
import { classifyResult, toIndexEntry } from "../src/scraper/outcome.ts"
import { decideFetch, planFetches } from "../src/scraper/plan.ts"
import { toSitemapEntry } from "../src/scraper/sitemap.ts"

const id = (n: number): RecipeId => Result.getOrThrow(Schema.decodeUnknownResult(RecipeId)(n))

const entry = (n: number, lastmod: string | null): SitemapEntry =>
  Option.getOrThrow(toSitemapEntry(`https://www.say7.info/cook/recipe/${n}-R${n}.html`, Option.fromNullishOr(lastmod)))

const cached = (n: number, overrides: Partial<RawIndexEntry> = {}): RawIndexEntry => ({
  id: id(n),
  url: `https://www.say7.info/cook/recipe/${n}-R${n}.html`,
  lastmod: "2025-01-01",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  status: "ok",
  httpStatus: 200,
  bytes: 100,
  sha256: "0".repeat(64),
  error: null,
  ...overrides
})

const indexOf = (...entries: ReadonlyArray<RawIndexEntry>): RawIndex => ({
  version: 1,
  entries: Object.fromEntries(entries.map((e) => [String(e.id), e]))
})

const reasonOf = (e: SitemapEntry, known: RawIndexEntry | null, fileExists: boolean, force = false) =>
  Option.getOrNull(decideFetch(e, Option.fromNullishOr(known), fileExists, force))

describe("decideFetch", () => {
  it("fetches an entry that is not in the index", () => {
    assert.strictEqual(reasonOf(entry(1, "2025-01-01"), null, false), "new")
  })

  it("skips an ok entry with the same lastmod and an existing file", () => {
    assert.strictEqual(reasonOf(entry(1, "2025-01-01"), cached(1), true), null)
  })

  it("fetches when the lastmod changed", () => {
    assert.strictEqual(reasonOf(entry(1, "2025-06-01"), cached(1), true), "changed")
  })

  it("fetches when the cache has no lastmod and the sitemap has one", () => {
    assert.strictEqual(reasonOf(entry(1, "2025-06-01"), cached(1, { lastmod: null }), true), "changed")
  })

  it("fetches when the file is missing", () => {
    assert.strictEqual(reasonOf(entry(1, "2025-01-01"), cached(1), false), "missing_file")
  })

  it("skips an ok entry when the sitemap has no lastmod", () => {
    assert.strictEqual(reasonOf(entry(1, null), cached(1), true), null)
    assert.strictEqual(reasonOf(entry(1, null), cached(1, { lastmod: null }), true), null)
  })

  it("fetches an ok entry without lastmod in the sitemap when the file is missing", () => {
    assert.strictEqual(reasonOf(entry(1, null), cached(1), false), "missing_file")
  })

  it("retries an entry with status error on every run, also with the same lastmod", () => {
    assert.strictEqual(reasonOf(entry(1, "2025-01-01"), cached(1, { status: "error" }), false), "retry")
    assert.strictEqual(reasonOf(entry(1, "2025-01-01"), cached(1, { status: "error" }), true), "retry")
    assert.strictEqual(reasonOf(entry(1, null), cached(1, { status: "error", lastmod: null }), false), "retry")
  })

  describe("status not_found", () => {
    const gone = (lastmod: string | null) => cached(1, { status: "not_found", lastmod, httpStatus: 404, bytes: null, sha256: null })

    it("skips when the sitemap has a lastmod and it is the same as in the index", () => {
      assert.strictEqual(reasonOf(entry(1, "2025-01-01"), gone("2025-01-01"), false), null)
    })

    it("skips whether or not an old HTML file is still on disk", () => {
      assert.strictEqual(reasonOf(entry(1, "2025-01-01"), gone("2025-01-01"), true), null)
    })

    it("retries when the lastmod is different", () => {
      assert.strictEqual(reasonOf(entry(1, "2025-06-01"), gone("2025-01-01"), false), "retry")
    })

    it("retries when the index has no lastmod and the sitemap has one", () => {
      assert.strictEqual(reasonOf(entry(1, "2025-06-01"), gone(null), false), "retry")
    })

    it("retries when the sitemap has no lastmod", () => {
      assert.strictEqual(reasonOf(entry(1, null), gone("2025-01-01"), false), "retry")
      assert.strictEqual(reasonOf(entry(1, null), gone(null), false), "retry")
    })

    it("fetches again with force", () => {
      assert.strictEqual(reasonOf(entry(1, "2025-01-01"), gone("2025-01-01"), false, true), "forced")
    })
  })

  it("fetches a current entry when force is on", () => {
    assert.strictEqual(reasonOf(entry(1, "2025-01-01"), cached(1), true, true), "forced")
  })
})

describe("planFetches", () => {
  const entries = [entry(1, "2025-01-01"), entry(2, "2025-01-01"), entry(3, "2025-01-01"), entry(4, null)]
  const index = indexOf(cached(1), cached(2, { lastmod: "2024-01-01" }), cached(4))
  const base = {
    entries,
    index,
    existingFiles: new Set([id(1), id(2), id(4)]),
    force: false,
    ids: Option.none<ReadonlySet<RecipeId>>(),
    limit: Option.none<number>()
  }
  const idsOf = (plan: ReturnType<typeof planFetches>) => plan.toFetch.map((planned) => planned.entry.id)

  it("plans the entries that need a fetch, in sitemap order", () => {
    const plan = planFetches(base)
    assert.deepStrictEqual(idsOf(plan), [2, 3])
    assert.deepStrictEqual(plan.toFetch.map((planned) => planned.reason), ["changed", "new"])
    assert.strictEqual(plan.skipped, 2)
    assert.strictEqual(plan.deferred, 0)
  })

  it("counts --limit over the entries that need a fetch, not over the whole sitemap", () => {
    const plan = planFetches({ ...base, limit: Option.some(1) })
    assert.deepStrictEqual(idsOf(plan), [2])
    assert.strictEqual(plan.deferred, 1)
    assert.strictEqual(plan.skipped, 2)
  })

  it("takes everything when --limit is larger than the work", () => {
    const plan = planFetches({ ...base, limit: Option.some(50) })
    assert.deepStrictEqual(idsOf(plan), [2, 3])
    assert.strictEqual(plan.deferred, 0)
  })

  it("restricts the plan to --ids", () => {
    const plan = planFetches({ ...base, ids: Option.some(new Set([id(3), id(4)])) })
    assert.deepStrictEqual(idsOf(plan), [3])
    assert.strictEqual(plan.skipped, 1)
  })

  it("skips current entries named by --ids unless --force is on", () => {
    const wanted = Option.some<ReadonlySet<RecipeId>>(new Set([id(1)]))
    assert.deepStrictEqual(idsOf(planFetches({ ...base, ids: wanted })), [])
    assert.deepStrictEqual(idsOf(planFetches({ ...base, ids: wanted, force: true })), [1])
  })

  it("reports --ids that the sitemap does not contain", () => {
    const plan = planFetches({ ...base, ids: Option.some(new Set([id(3), id(99)])) })
    assert.deepStrictEqual(plan.unknownIds, [id(99)])
    assert.deepStrictEqual(idsOf(plan), [3])
  })

  it("does not plan a not_found entry with the same lastmod, but plans it after a lastmod change", () => {
    const missing = cached(3, { status: "not_found", lastmod: "2025-01-01", httpStatus: 404, bytes: null, sha256: null })
    const withMissing = { ...base, index: indexOf(cached(1), cached(2), missing, cached(4)) }
    assert.deepStrictEqual(idsOf(planFetches(withMissing)), [])
    const changed = { ...withMissing, entries: [entry(1, "2025-01-01"), entry(2, "2025-01-01"), entry(3, "2025-09-09"), entry(4, null)] }
    assert.deepStrictEqual(idsOf(planFetches(changed)), [3])
  })

  it("fetches everything with --force and applies --limit in sitemap order", () => {
    const plan = planFetches({ ...base, force: true, limit: Option.some(2) })
    assert.deepStrictEqual(idsOf(plan), [1, 2])
    assert.strictEqual(plan.deferred, 2)
    assert.strictEqual(plan.skipped, 0)
  })
})

describe("toIndexEntry", () => {
  const when = "2026-10-12T10:00:00.000Z"
  const e = entry(5, "2025-03-03")
  const fetched = { _tag: "Fetched", httpStatus: 200, bytes: 12, sha256: "a".repeat(64) } as const

  it("records a fetched page", () => {
    const record = toIndexEntry(e, Option.none(), false, fetched, when)
    assert.deepStrictEqual(record, {
      id: e.id,
      url: e.url,
      lastmod: "2025-03-03",
      fetchedAt: when,
      status: "ok",
      httpStatus: 200,
      bytes: 12,
      sha256: "a".repeat(64),
      error: null
    })
  })

  it("records null for a missing lastmod", () => {
    assert.strictEqual(toIndexEntry(entry(5, null), Option.none(), false, fetched, when).lastmod, null)
  })

  it("records not_found with HTTP 404", () => {
    const record = toIndexEntry(e, Option.none(), false, { _tag: "NotFound" }, when)
    assert.strictEqual(record.status, "not_found")
    assert.strictEqual(record.httpStatus, 404)
    assert.strictEqual(record.sha256, null)
  })

  it("records an error with its message", () => {
    const record = toIndexEntry(e, Option.none(), false, {
      _tag: "Failed",
      httpStatus: Option.some(503),
      message: "HTTP 503"
    }, when)
    assert.strictEqual(record.status, "error")
    assert.strictEqual(record.httpStatus, 503)
    assert.strictEqual(record.error, "HTTP 503")
  })

  it("keeps an earlier ok entry when a refetch fails and the file is still there", () => {
    const earlier = cached(5)
    const failed = { _tag: "Failed", httpStatus: Option.none(), message: "timeout" } as const
    assert.deepStrictEqual(toIndexEntry(e, Option.some(earlier), true, failed, when), earlier)
    assert.strictEqual(toIndexEntry(e, Option.some(earlier), false, failed, when).status, "error")
  })

  it("replaces an earlier ok entry when the page is gone", () => {
    const record = toIndexEntry(e, Option.some(cached(5)), true, { _tag: "NotFound" }, when)
    assert.strictEqual(record.status, "not_found")
  })
})

describe("classifyResult", () => {
  const response = (status: number, body: string): HttpResponse => ({
    url: "http://x/",
    status,
    contentType: Option.some("text/html"),
    body: new TextEncoder().encode(body)
  })

  it("marks a response with a body as fetched and hashes the original bytes", () => {
    const { outcome, page } = classifyResult(Result.succeed(response(200, "abc")))
    assert.deepStrictEqual(outcome, {
      _tag: "Fetched",
      httpStatus: 200,
      bytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    })
    assert.isTrue(Option.isSome(page))
  })

  it("marks an empty 200 response as failed", () => {
    const { outcome, page } = classifyResult(Result.succeed(response(200, "")))
    assert.deepStrictEqual(outcome, { _tag: "Failed", httpStatus: Option.some(200), message: "Empty response body" })
    assert.isTrue(Option.isNone(page))
  })

  it("marks a 404 as not found", () => {
    const failure = new HttpStatusError({ url: "http://x/", status: 404, retryAfter: Option.none() })
    assert.deepStrictEqual(classifyResult(Result.fail(failure)).outcome, { _tag: "NotFound" })
  })

  it("marks other HTTP statuses and network errors as failed", () => {
    const status = new HttpStatusError({ url: "http://x/", status: 503, retryAfter: Option.none() })
    assert.deepStrictEqual(classifyResult(Result.fail(status)).outcome, {
      _tag: "Failed",
      httpStatus: Option.some(503),
      message: "HTTP 503"
    })
    const network = new NetworkError({ url: "http://x/", reason: "timeout", message: "Timeout after 30000 ms" })
    assert.deepStrictEqual(classifyResult(Result.fail(network)).outcome, {
      _tag: "Failed",
      httpStatus: Option.none(),
      message: "Timeout after 30000 ms"
    })
  })
})
