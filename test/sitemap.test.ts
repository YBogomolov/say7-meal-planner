import { assert, describe, it } from "@effect/vitest"
import { Option, Result } from "effect"
import { parseSitemap, recipePath, toSitemapEntry } from "../src/scraper/sitemap.ts"

const REAL_START = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

<url><loc>https://www.say7.info/</loc></url>

<url><loc>https://www.say7.info/cook/recipe/1590-Tort-Tri.html</loc>
<lastmod>2025-10-20</lastmod>
</url>

<url><loc>https://www.say7.info/cook/recipe/56-Salat-Mimoza.html</loc>
<lastmod>2026-03-11</lastmod>
</url>

<url><loc>https://www.say7.info/cook/recipe/1740-Kurinyie-serdechki.html</loc>
<lastmod>2026-09-08</lastmod>
</url>
</urlset>
`

const parse = (xml: string) => {
  const result = parseSitemap(xml)
  if (Result.isFailure(result)) {
    assert.fail(`expected success, got ${result.failure.message}`)
  }
  return result.success
}

describe("parseSitemap", () => {
  it("reads the start of the real sitemap: skips the home page, keeps recipes in order", () => {
    const entries = parse(REAL_START)
    assert.deepStrictEqual(
      entries.map((entry) => `${entry.id} ${entry.slug} ${Option.getOrNull(entry.lastmod)}`),
      ["1590 Tort-Tri 2025-10-20", "56 Salat-Mimoza 2026-03-11", "1740 Kurinyie-serdechki 2026-09-08"]
    )
    assert.strictEqual(entries[0]?.url, "https://www.say7.info/cook/recipe/1590-Tort-Tri.html")
  })

  it("gives lastmod None when the entry has none", () => {
    const entries = parse(
      `<urlset><url><loc>https://www.say7.info/cook/recipe/7-Borshch.html</loc></url></urlset>`
    )
    assert.strictEqual(entries.length, 1)
    assert.isTrue(Option.isNone(entries[0]?.lastmod ?? Option.some("x")))
  })

  it("treats an invalid lastmod as missing", () => {
    const entries = parse(
      `<urlset><url><loc>https://www.say7.info/cook/recipe/7-Borshch.html</loc><lastmod>soon</lastmod></url></urlset>`
    )
    assert.strictEqual(entries.length, 1)
    assert.isTrue(Option.isNone(entries[0]?.lastmod ?? Option.some("x")))
  })

  it("keeps the first of two entries with the same ID", () => {
    const entries = parse(
      `<urlset>
        <url><loc>https://www.say7.info/cook/recipe/7-A.html</loc><lastmod>2025-01-01</lastmod></url>
        <url><loc>https://www.say7.info/cook/recipe/7-B.html</loc><lastmod>2025-02-02</lastmod></url>
      </urlset>`
    )
    assert.deepStrictEqual(entries.map((entry) => entry.slug), ["A"])
  })

  it("decodes XML entities and trims white space in loc", () => {
    const entries = parse(
      `<urlset><url><loc>
        https://www.say7.info/cook/recipe/9-Hleb&amp;sol.html
      </loc></url></urlset>`
    )
    assert.deepStrictEqual(entries.map((entry) => entry.slug), ["Hleb&sol"])
  })

  it("fails when the text is not a sitemap", () => {
    const result = parseSitemap("<html><body>Service unavailable</body></html>")
    assert.isTrue(Result.isFailure(result))
  })

  it("returns an empty list for a sitemap without recipes", () => {
    assert.deepStrictEqual(parse(`<urlset><url><loc>https://www.say7.info/</loc></url></urlset>`), [])
  })
})

describe("recipe URL filter (toSitemapEntry)", () => {
  const accepts = (loc: string) => Option.isSome(toSitemapEntry(loc, Option.none()))

  it("accepts recipe pages", () => {
    assert.isTrue(accepts("https://www.say7.info/cook/recipe/1-A.html"))
    assert.isTrue(accepts("https://www.say7.info/cook/recipe/123-Salat-Mimoza.html"))
    assert.isTrue(accepts("http://127.0.0.1:8080/cook/recipe/5-Test.html"))
  })

  it.each([
    ["the home page", "https://www.say7.info/"],
    ["a query string", "https://www.say7.info/cook/recipe/1-A.html?x=1"],
    ["a bare question mark", "https://www.say7.info/cook/recipe/1-A.html?"],
    ["a fragment", "https://www.say7.info/cook/recipe/1-A.html#top"],
    ["a search page", "https://www.say7.info/search.html"],
    ["a search page with a query", "https://www.say7.info/search.html?q=soup"],
    ["gosearch.php", "https://www.say7.info/gosearch.php?q=1"],
    ["an image", "https://www.say7.info/cook/recipe/1-A.jpg"],
    ["an image in a recipe folder", "https://www.say7.info/cook/recipe/img/1-A.html.jpg"],
    ["a recipe without ID", "https://www.say7.info/cook/recipe/Salat.html"],
    ["a recipe with a non-numeric ID", "https://www.say7.info/cook/recipe/x1-Salat.html"],
    ["ID zero", "https://www.say7.info/cook/recipe/0-Salat.html"],
    ["a sub folder", "https://www.say7.info/cook/recipe/a/1-Salat.html"],
    ["another folder", "https://www.say7.info/cook/other/1-Salat.html"],
    ["an empty slug", "https://www.say7.info/cook/recipe/1-.html"],
    ["a non-HTTP scheme", "ftp://www.say7.info/cook/recipe/1-A.html"],
    ["text that is not a URL", "not a url"]
  ])("rejects %s", (_name, loc) => {
    assert.isFalse(accepts(loc))
  })
})

describe("recipePath", () => {
  it("returns the path of the URL", () => {
    const entry = toSitemapEntry("https://www.say7.info/cook/recipe/56-Salat-Mimoza.html", Option.none())
    assert.strictEqual(Option.map(entry, recipePath).pipe(Option.getOrNull), "/cook/recipe/56-Salat-Mimoza.html")
  })
})
