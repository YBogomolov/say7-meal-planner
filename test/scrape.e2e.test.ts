import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Schema } from "effect"
import { RawIndexJson } from "../src/domain/raw-index.ts"
import type { RawIndex } from "../src/domain/raw-index.ts"
import { IsoTimestamp } from "../src/domain/recipe.ts"
import { sha256Hex } from "../src/scraper/hash.ts"
import { USER_AGENT } from "../src/scraper/http.ts"
import { MAX_CONSECUTIVE_ERRORS } from "../src/scraper/run.ts"
import {
  newConsoleLog,
  pagePath,
  recipeBytes,
  recipeHtml,
  RECIPES,
  routeRecipe,
  routeRobots,
  routeSitemap,
  SALAT,
  scrapeWith,
  SERDECHKI,
  startRecipeSite,
  summaryOf,
  TORT
} from "./support/scrape.ts"
import type { RecipeFixture } from "./support/scrape.ts"
import { startTestSite } from "./support/site.ts"

/** A temporary data directory that is removed when the test ends. */
const tempDataDir = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "say7-e2e-" })
}).pipe(Effect.provide(NodeFileSystem.layer))

const readIndex = (dataDir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(`${dataDir}/raw/index.json`)
    return yield* Schema.decodeUnknownEffect(RawIndexJson)(text)
  }).pipe(Effect.provide(NodeFileSystem.layer))

const fileNames = (dataDir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return (yield* fs.readDirectory(`${dataDir}/raw`)).toSorted()
  }).pipe(Effect.provide(NodeFileSystem.layer))

const readPage = (dataDir: string, id: number) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFile(`${dataDir}/raw/${id}.html`)
  }).pipe(Effect.provide(NodeFileSystem.layer))

const statusOf = (index: RawIndex, id: number) => index.entries[String(id)]?.status

const pageRequests = (requests: ReadonlyArray<{ readonly url: string }>) =>
  requests.map((request) => request.url).filter((url) => url.startsWith("/cook/recipe/"))

describe("scrape: normal fetch", () => {
  it.live("downloads every recipe, decodes windows-1251 and stores UTF-8", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      const log = newConsoleLog()

      const summary = yield* scrapeWith(site, dataDir, [], log)
      assert.deepStrictEqual(summary, summaryOf(3, 0))

      // robots.txt comes first, then the sitemap, then the recipes in sitemap order.
      // The search URL, the image and the home page of the sitemap are not requested.
      assert.deepStrictEqual(site.requests.map((request) => request.url), [
        "/robots.txt",
        "/sitemap.xml",
        pagePath(TORT),
        pagePath(SALAT),
        pagePath(SERDECHKI)
      ])
      assert.isTrue(site.requests.every((request) => request.userAgent === USER_AGENT))
      assert.isTrue(site.requests.every((request) => !request.url.includes("?")))

      // Every file is valid UTF-8 and has the original Cyrillic text, for all three charset hints.
      for (const recipe of RECIPES) {
        const bytes = yield* readPage(dataDir, recipe.id)
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        assert.strictEqual(text, recipeHtml(recipe))
      }
      const serdechki = new TextDecoder().decode(yield* readPage(dataDir, SERDECHKI.id))
      assert.include(serdechki, "Куриные сердечки")
      assert.include(serdechki, "Ёж, ёлка и № 5 — вкусно.")

      // The index describes the original bytes.
      const index = yield* readIndex(dataDir)
      assert.deepStrictEqual(Object.keys(index.entries), ["56", "1590", "1740"])
      const tort = index.entries["1590"]
      const original = recipeBytes(TORT)
      assert.strictEqual(tort?.status, "ok")
      assert.strictEqual(tort?.httpStatus, 200)
      assert.strictEqual(tort?.bytes, original.length)
      assert.strictEqual(tort?.sha256, sha256Hex(original))
      assert.notStrictEqual(tort?.sha256, sha256Hex(new TextEncoder().encode(recipeHtml(TORT))))
      assert.strictEqual(tort?.lastmod, "2025-10-20")
      assert.strictEqual(tort?.url, "https://www.say7.info/cook/recipe/1590-Tort-Tri.html")
      assert.strictEqual(tort?.error, null)
      assert.isTrue(Schema.is(IsoTimestamp)(tort?.fetchedAt))
      assert.strictEqual(index.entries["1740"]?.lastmod, null)

      // No leftovers of the atomic writes.
      assert.deepStrictEqual(yield* fileNames(dataDir), ["1590.html", "1740.html", "56.html", "index.json"])

      // The log: 1 line per page, then the totals.
      assert.deepStrictEqual(log.lines[0], "sitemap: 3 recipes; 3 to fetch, 0 up to date")
      const pageLines = log.lines.filter((line) => line.startsWith("["))
      assert.strictEqual(pageLines.length, 3)
      assert.match(pageLines[0] ?? "", /^\[1\/3\] 1590 ok \d+\.\d KB \d+ ms$/)
      assert.match(pageLines[1] ?? "", /^\[2\/3\] 56 ok \d+\.\d KB \d+ ms$/)
      assert.match(pageLines[2] ?? "", /^\[3\/3\] 1740 ok \d+\.\d KB \d+ ms$/)
      assert.strictEqual(log.lines.at(-1), "done: fetched 3, skipped 0, not found 0, errors 0")
    }))
})

describe("scrape: incremental update", () => {
  it.live("skips current pages on the second run and fetches only what changed", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()

      yield* scrapeWith(site, dataDir)
      assert.strictEqual(pageRequests(site.requests).length, 3)

      // Second run: nothing changed. Only robots.txt and the sitemap are requested.
      const second = yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(second, summaryOf(0, 3))
      assert.strictEqual(pageRequests(site.requests).length, 3)
      assert.strictEqual(site.hits("/robots.txt"), 2)
      assert.strictEqual(site.hits("/sitemap.xml"), 2)

      // One recipe gets a new lastmod. Only that page is fetched again.
      routeSitemap(site, [TORT, { ...SALAT, lastmod: "2026-09-30" }, SERDECHKI])
      const third = yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(third, summaryOf(1, 2))
      assert.strictEqual(site.hits(pagePath(SALAT)), 2)
      assert.strictEqual(site.hits(pagePath(TORT)), 1)
      assert.strictEqual((yield* readIndex(dataDir)).entries["56"]?.lastmod, "2026-09-30")

      // A deleted file is fetched again. A recipe without lastmod in the sitemap stays cached.
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(`${dataDir}/raw/1590.html`)
      const fourth = yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(fourth, summaryOf(1, 2))
      assert.strictEqual(site.hits(pagePath(TORT)), 2)
      assert.strictEqual(site.hits(pagePath(SERDECHKI)), 1)
    }).pipe(Effect.provide(NodeFileSystem.layer)))
})

describe("scrape: errors", () => {
  it.live("records a 404 as not_found, does not retry, and skips it while the lastmod stays the same", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      site.route(pagePath(SALAT), () => ({ status: 404, body: "gone" }))
      const log = newConsoleLog()

      const summary = yield* scrapeWith(site, dataDir, [], log)
      assert.deepStrictEqual(summary, summaryOf(2, 0, 1))
      assert.strictEqual(site.hits(pagePath(SALAT)), 1)

      const entry = (yield* readIndex(dataDir)).entries["56"]
      assert.strictEqual(entry?.status, "not_found")
      assert.strictEqual(entry?.httpStatus, 404)
      assert.strictEqual(entry?.sha256, null)
      assert.deepStrictEqual(yield* fileNames(dataDir), ["1590.html", "1740.html", "index.json"])
      assert.isTrue(log.lines.some((line) => /^\[2\/3\] 56 not_found - \d+ ms$/.test(line)))

      // Same lastmod in the sitemap: the page is not requested again.
      const second = yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(second, summaryOf(0, 3))
      assert.strictEqual(site.hits(pagePath(SALAT)), 1)

      // --force fetches it anyway.
      const forced = yield* scrapeWith(site, dataDir, ["--force", "--ids", "56"])
      assert.deepStrictEqual(forced, summaryOf(0, 0, 1))
      assert.strictEqual(site.hits(pagePath(SALAT)), 2)

      // The sitemap shows a new lastmod and the page is back.
      routeRecipe(site, SALAT)
      routeSitemap(site, [TORT, { ...SALAT, lastmod: "2026-09-30" }, SERDECHKI])
      const again = yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(again, summaryOf(1, 2))
      assert.strictEqual(statusOf(yield* readIndex(dataDir), 56), "ok")
    }))

  it.live("tries a not_found page again on every run when the sitemap has no lastmod", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      site.route(pagePath(SERDECHKI), () => ({ status: 404 }))
      assert.deepStrictEqual(yield* scrapeWith(site, dataDir), summaryOf(2, 0, 1))
      assert.deepStrictEqual(yield* scrapeWith(site, dataDir), summaryOf(0, 2, 1))
      assert.strictEqual(site.hits(pagePath(SERDECHKI)), 2)
    }))

  it.live("retries a 503 and stores the later 200", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      site.route(pagePath(SALAT), (hit) =>
        hit === 1 ? { status: 503, headers: { "retry-after": "0" } } : { status: 200, headers: { "content-type": "text/html; charset=windows-1251" }, body: recipeBytes(SALAT) })
      const log = newConsoleLog()

      const summary = yield* scrapeWith(site, dataDir, [], log)
      assert.deepStrictEqual(summary, summaryOf(3, 0))
      assert.strictEqual(site.hits(pagePath(SALAT)), 2)
      assert.strictEqual(statusOf(yield* readIndex(dataDir), 56), "ok")
      assert.isTrue(log.warnings.some((line) => line.includes("retry 1/3") && line.includes("HTTP 503")))
      const text = new TextDecoder().decode(yield* readPage(dataDir, SALAT.id))
      assert.strictEqual(text, recipeHtml(SALAT))
    }))

  it.live("retries a 429 as well", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      site.route(pagePath(TORT), (hit) =>
        hit <= 2 ? { status: 429 } : { status: 200, headers: { "content-type": "text/html; charset=windows-1251" }, body: recipeBytes(TORT) })
      assert.deepStrictEqual(yield* scrapeWith(site, dataDir), summaryOf(3, 0))
      assert.strictEqual(site.hits(pagePath(TORT)), 3)
    }))

  it.live("records a page that fails after 3 retries as error and goes on with the next page", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      site.route(pagePath(SALAT), () => ({ status: 500 }))
      const log = newConsoleLog()

      const summary = yield* scrapeWith(site, dataDir, [], log)
      assert.deepStrictEqual(summary, summaryOf(2, 0, 0, 1))
      assert.strictEqual(site.hits(pagePath(SALAT)), 4)
      assert.strictEqual(site.hits(pagePath(SERDECHKI)), 1)

      const entry = (yield* readIndex(dataDir)).entries["56"]
      assert.strictEqual(entry?.status, "error")
      assert.strictEqual(entry?.httpStatus, 500)
      assert.strictEqual(entry?.error, "HTTP 500")
      assert.isFalse((yield* fileNames(dataDir)).includes("56.html"))
      assert.isTrue(log.lines.some((line) => /^\[2\/3\] 56 error - \d+ ms \(HTTP 500\)$/.test(line)))
      assert.strictEqual(log.lines.at(-1), "done: fetched 2, skipped 0, not found 0, errors 1")

      // The server recovers. Only the failed page is fetched.
      routeRecipe(site, SALAT)
      assert.deepStrictEqual(yield* scrapeWith(site, dataDir), summaryOf(1, 2))
      assert.strictEqual(statusOf(yield* readIndex(dataDir), 56), "ok")
    }))

  it.live("does not retry other 4xx statuses", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      site.route(pagePath(SALAT), () => ({ status: 403 }))
      const summary = yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(summary, summaryOf(2, 0, 0, 1))
      assert.strictEqual(site.hits(pagePath(SALAT)), 1)
      assert.strictEqual((yield* readIndex(dataDir)).entries["56"]?.httpStatus, 403)
    }))

  it.live("keeps the earlier copy when a refetch fails", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      yield* scrapeWith(site, dataDir)
      const before = (yield* readIndex(dataDir)).entries["56"]

      routeSitemap(site, [TORT, { ...SALAT, lastmod: "2026-12-01" }, SERDECHKI])
      site.route(pagePath(SALAT), () => ({ status: 502 }))
      const summary = yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(summary, summaryOf(0, 2, 0, 1))

      assert.deepStrictEqual((yield* readIndex(dataDir)).entries["56"], before)
      const text = new TextDecoder().decode(yield* readPage(dataDir, SALAT.id))
      assert.strictEqual(text, recipeHtml(SALAT))

      // The next run fetches the page again, because the lastmod still differs.
      routeRecipe(site, SALAT)
      assert.deepStrictEqual(yield* scrapeWith(site, dataDir), summaryOf(1, 2))
      assert.strictEqual((yield* readIndex(dataDir)).entries["56"]?.lastmod, "2026-12-01")
    }))

  it.live("records a 200 with an empty body as error", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      site.route(pagePath(TORT), () => ({ status: 200, headers: { "content-type": "text/html" }, body: "" }))
      assert.deepStrictEqual(yield* scrapeWith(site, dataDir), summaryOf(2, 0, 0, 1))
      const entry = (yield* readIndex(dataDir)).entries["1590"]
      assert.strictEqual(entry?.status, "error")
      assert.strictEqual(entry?.error, "Empty response body")
    }))
})

describe("scrape: flags", () => {
  it.live("--ids fetches only the named recipes", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      const summary = yield* scrapeWith(site, dataDir, ["--ids", "1740,56"])
      assert.deepStrictEqual(summary, summaryOf(2, 0))
      assert.deepStrictEqual(pageRequests(site.requests), [pagePath(SALAT), pagePath(SERDECHKI)])
      assert.deepStrictEqual(yield* fileNames(dataDir), ["1740.html", "56.html", "index.json"])
    }))

  it.live("--ids warns about an ID that is not in the sitemap", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      const log = newConsoleLog()
      const summary = yield* scrapeWith(site, dataDir, ["--ids", "56,999"], log)
      assert.deepStrictEqual(summary, summaryOf(1, 0))
      assert.deepStrictEqual(log.warnings, ["warning: IDs not in the sitemap: 999"])
    }))

  it.live("--limit fetches the first n recipes that need a fetch, and the next run continues", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      const log = newConsoleLog()

      const first = yield* scrapeWith(site, dataDir, ["--limit", "2"], log)
      assert.deepStrictEqual(first, summaryOf(2, 0, 0, 0, 1))
      assert.deepStrictEqual(pageRequests(site.requests), [pagePath(TORT), pagePath(SALAT)])
      assert.strictEqual(log.lines[0], "sitemap: 3 recipes; 2 to fetch, 0 up to date, 1 more after --limit")
      assert.match(log.lines[1] ?? "", /^\[1\/2\] 1590 ok /)
      assert.strictEqual(log.lines.at(-1), "done: fetched 2, skipped 0, not found 0, errors 0, not processed because of --limit 1")

      // The limit counts entries that need a fetch. The 2 cached recipes do not use it up.
      const second = yield* scrapeWith(site, dataDir, ["--limit", "1"])
      assert.deepStrictEqual(second, summaryOf(1, 2))
      assert.deepStrictEqual(pageRequests(site.requests).slice(2), [pagePath(SERDECHKI)])
      assert.deepStrictEqual(yield* fileNames(dataDir), ["1590.html", "1740.html", "56.html", "index.json"])
    }))

  it.live("--force fetches current pages again", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      yield* scrapeWith(site, dataDir)
      const forced = yield* scrapeWith(site, dataDir, ["--force"])
      assert.deepStrictEqual(forced, summaryOf(3, 0))
      assert.strictEqual(site.hits(pagePath(TORT)), 2)

      const forcedOne = yield* scrapeWith(site, dataDir, ["--force", "--ids", "56"])
      assert.deepStrictEqual(forcedOne, summaryOf(1, 0))
      assert.strictEqual(site.hits(pagePath(SALAT)), 3)
      assert.strictEqual(site.hits(pagePath(TORT)), 2)
    }))

  it.live("--force with --limit takes the first n entries of the sitemap", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      yield* scrapeWith(site, dataDir)
      const forced = yield* scrapeWith(site, dataDir, ["--force", "--limit", "1"])
      assert.deepStrictEqual(forced, summaryOf(1, 0, 0, 0, 2))
      assert.strictEqual(site.hits(pagePath(TORT)), 2)
      assert.strictEqual(site.hits(pagePath(SALAT)), 1)
    }))

  it.live("--delay-ms sets the pause between requests", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      const started = Date.now()
      // 4 gaps (robots, sitemap, 3 pages) of at least 0.8 * 100 ms.
      yield* scrapeWith(site, dataDir, ["--delay-ms", "100"])
      assert.isTrue(Date.now() - started >= 300)
    }))
})

describe("scrape: robots.txt and sitemap", () => {
  it.live("stops before the first page when robots.txt disallows the recipes", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      routeRobots(site, "User-agent: *\nDisallow: /cook/recipe/\n")
      const error = yield* Effect.flip(scrapeWith(site, dataDir))
      assert.strictEqual(error._tag, "RobotsError")
      assert.deepStrictEqual(pageRequests(site.requests), [])
      assert.deepStrictEqual(site.requests.map((request) => request.url), ["/robots.txt", "/sitemap.xml"])
    }))

  it.live("stops when only the recipe pattern is disallowed for the agent", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      routeRobots(site, "User-agent: *\nDisallow: /cook/recipe/*.html$\n")
      const error = yield* Effect.flip(scrapeWith(site, dataDir))
      assert.strictEqual(error._tag, "RobotsError")
      assert.deepStrictEqual(pageRequests(site.requests), [])
    }))

  it.live("stops when robots.txt cannot be read", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startTestSite
      routeSitemap(site, RECIPES)
      const error = yield* Effect.flip(scrapeWith(site, dataDir))
      assert.strictEqual(error._tag, "SourceError")
      assert.strictEqual(error._tag === "SourceError" ? error.url : "", `${site.origin}/robots.txt`)
      assert.deepStrictEqual(site.requests.map((request) => request.url), ["/robots.txt"])
    }))

  it.live("fails when the sitemap is not a sitemap", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      site.route("/sitemap.xml", () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>maintenance</html>" }))
      const error = yield* Effect.flip(scrapeWith(site, dataDir))
      assert.strictEqual(error._tag, "SitemapError")
      assert.deepStrictEqual(pageRequests(site.requests), [])
    }))

  it.live("fails when the sitemap has no recipes", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite([])
      const error = yield* Effect.flip(scrapeWith(site, dataDir))
      assert.strictEqual(error._tag, "SitemapError")
    }))

  it.live("fails when nothing listens at the base URL", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const closed = yield* Effect.scoped(startTestSite)
      const error = yield* Effect.flip(scrapeWith(closed, dataDir))
      assert.strictEqual(error._tag, "SourceError")
    }))

  it.live("refuses a broken index.json before any request", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${dataDir}/raw`, { recursive: true })
      yield* fs.writeFileString(`${dataDir}/raw/index.json`, "{ broken")
      const site = yield* startRecipeSite()
      const error = yield* Effect.flip(scrapeWith(site, dataDir))
      assert.strictEqual(error._tag, "IndexInvalidError")
      assert.strictEqual(site.requests.length, 0)
      assert.strictEqual(yield* fs.readFileString(`${dataDir}/raw/index.json`), "{ broken")
    }).pipe(Effect.provide(NodeFileSystem.layer)))
})

describe("scrape: stop and resume", () => {
  it.live("keeps finished pages when the run is interrupted, and the next run continues", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite()
      // The second page never answers, as if the user pressed Ctrl+C during the request.
      site.route(pagePath(SALAT), () => ({ status: 200, hang: true }))
      const log = newConsoleLog()

      const fiber = yield* Effect.forkChild(scrapeWith(site, dataDir, [], log))
      while (site.hits(pagePath(SALAT)) === 0) {
        yield* Effect.sleep(5)
      }
      yield* Fiber.interrupt(fiber)

      const index = yield* readIndex(dataDir)
      assert.deepStrictEqual(Object.keys(index.entries), ["1590"])
      assert.deepStrictEqual(yield* fileNames(dataDir), ["1590.html", "index.json"])
      assert.strictEqual(log.lines.at(-1), "done: fetched 1, skipped 0, not found 0, errors 0")

      routeRecipe(site, SALAT)
      const resumed = yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(resumed, summaryOf(2, 1))
      assert.strictEqual(site.hits(pagePath(TORT)), 1)
      assert.deepStrictEqual(yield* fileNames(dataDir), ["1590.html", "1740.html", "56.html", "index.json"])
      assert.strictEqual(statusOf(yield* readIndex(dataDir), 56), "ok")
    }))

  it.live("removes a temporary file that an earlier crash left behind", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${dataDir}/raw`, { recursive: true })
      yield* fs.writeFileString(`${dataDir}/raw/56.html.tmp`, "half a page")
      yield* fs.writeFileString(`${dataDir}/raw/index.json.tmp`, "{")
      const site = yield* startRecipeSite()
      yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(yield* fileNames(dataDir), ["1590.html", "1740.html", "56.html", "index.json"])
    }).pipe(Effect.provide(NodeFileSystem.layer)))
})

describe("scrape: circuit breaker", () => {
  const recipe = (id: number): RecipeFixture => ({
    id,
    slug: `Recipe-${id}`,
    lastmod: "2026-01-01",
    title: `Рецепт ${id}`,
    charsetHint: "header"
  })
  const six = [1, 2, 3, 4, 5, 6].map(recipe)

  it.live("stops after 5 pages in a row with status error and does not request the 6th", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite(six)
      for (const item of six) {
        site.route(pagePath(item), () => ({ status: 500 }))
      }
      const log = newConsoleLog()

      const error = yield* Effect.flip(scrapeWith(site, dataDir, [], log))
      assert.strictEqual(error._tag, "CircuitBreakerError")
      assert.include(error.message, `${MAX_CONSECUTIVE_ERRORS} pages in a row`)

      // Each of the first 5 pages got 1 try and 3 retries. The 6th page was never requested.
      for (const item of six.slice(0, 5)) {
        assert.strictEqual(site.hits(pagePath(item)), 4)
      }
      assert.strictEqual(site.hits(pagePath(recipe(6))), 0)
      assert.strictEqual(MAX_CONSECUTIVE_ERRORS, 5)

      // The 5 failures are saved, and the totals are printed.
      const index = yield* readIndex(dataDir)
      assert.deepStrictEqual(Object.keys(index.entries), ["1", "2", "3", "4", "5"])
      assert.isTrue(Object.values(index.entries).every((entry) => entry.status === "error"))
      assert.strictEqual(log.lines.at(-1), "done: fetched 0, skipped 0, not found 0, errors 5")

      // After a pause the next run starts with the failed pages and the 6th page.
      for (const item of six) {
        routeRecipe(site, item)
      }
      assert.deepStrictEqual(yield* scrapeWith(site, dataDir), summaryOf(6, 0))
    }))

  it.live("does not stop when a good page or a 404 comes between the errors", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite(six)
      // Pages 1 to 4 fail, page 5 is missing, page 6 fails: 5 errors in total, but never 5 in a row.
      for (const item of [1, 2, 3, 4, 6]) {
        site.route(pagePath(recipe(item)), () => ({ status: 500 }))
      }
      site.route(pagePath(recipe(5)), () => ({ status: 404 }))

      const summary = yield* scrapeWith(site, dataDir)
      assert.deepStrictEqual(summary, summaryOf(0, 0, 1, 5))
      assert.strictEqual(site.hits(pagePath(recipe(6))), 4)
    }))

  it.live("does not trip below the threshold (4 errors with --limit 4)", () =>
    Effect.gen(function*() {
      const dataDir = yield* tempDataDir
      const site = yield* startRecipeSite(six)
      for (const item of six) {
        site.route(pagePath(item), () => ({ status: 500 }))
      }
      const summary = yield* scrapeWith(site, dataDir, ["--limit", "4"])
      assert.deepStrictEqual(summary, summaryOf(0, 0, 0, 4, 2))
    }))
})
