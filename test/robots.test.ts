import { assert, describe, it } from "@effect/vitest"
import { USER_AGENT } from "../src/scraper/http.ts"
import { isAllowed, parseRobots, patternMatches, productToken } from "../src/scraper/robots.ts"
import { REAL_ROBOTS_TXT } from "./support/site.ts"

const real = parseRobots(REAL_ROBOTS_TXT)

describe("parseRobots", () => {
  it("reads the groups and the sitemap line of the real robots.txt", () => {
    assert.deepStrictEqual(
      real.groups.map((group) => group.agents),
      [["*"], ["yandex"]]
    )
    assert.deepStrictEqual(
      real.groups[0]?.rules.map((rule) => `${rule.allow ? "Allow" : "Disallow"} ${rule.pattern}`),
      [
        "Disallow /cdn-cgi/",
        "Disallow /gogoogle.html?*",
        "Disallow /gosearch.php?*",
        "Disallow /search.html?*",
        "Allow /cook/recipe/*.html$",
        "Disallow /cook/recipe/*?",
        "Disallow /?*",
      ]
    )
    assert.deepStrictEqual(real.sitemaps, ["https://www.say7.info/sitemap.xml"])
  })

  it("joins consecutive User-agent lines into one group and strips comments", () => {
    const robots = parseRobots(
      "# top\nUser-agent: A\nUser-agent: B # both\nDisallow: /x # no\n\nUser-agent: C\nAllow: /y\n"
    )
    assert.deepStrictEqual(
      robots.groups.map((group) => group.agents),
      [["a", "b"], ["c"]]
    )
    assert.deepStrictEqual(robots.groups[0]?.rules, [{ allow: false, pattern: "/x" }])
  })

  it("accepts CRLF line ends and any case in field names", () => {
    const robots = parseRobots("USER-AGENT: *\r\nDISALLOW: /private\r\n")
    assert.isFalse(isAllowed(robots, USER_AGENT, "/private/a.html"))
  })

  it("drops an empty Disallow, which allows everything", () => {
    const robots = parseRobots("User-agent: *\nDisallow:\n")
    assert.deepStrictEqual(robots.groups[0]?.rules, [])
    assert.isTrue(isAllowed(robots, USER_AGENT, "/anything"))
  })

  it("ignores rules before the first User-agent line", () => {
    const robots = parseRobots("Disallow: /\nUser-agent: *\nAllow: /\n")
    assert.isTrue(isAllowed(robots, USER_AGENT, "/a"))
  })
})

describe("patternMatches", () => {
  it.each([
    ["/cook/", "/cook/recipe/1-A.html", true],
    ["/cook/", "/other", false],
    ["/cook/recipe/*.html$", "/cook/recipe/1-A.html", true],
    ["/cook/recipe/*.html$", "/cook/recipe/1-A.html?x=1", false],
    ["/cook/recipe/*.html$", "/cook/recipe/1-A.htmlx", false],
    ["/cook/recipe/*?", "/cook/recipe/1-A.html?x=1", true],
    ["/cook/recipe/*?", "/cook/recipe/1-A.html", false],
    ["/*.php", "/dir/a.php", true],
    ["/a.b", "/axb", false],
    ["/?*", "/?x=1", true],
    ["/?*", "/", false],
    ["/a+b", "/a+b/c", true],
  ])("pattern %s on %s is %s", (pattern, path, expected) => {
    assert.strictEqual(patternMatches(pattern, path), expected)
  })
})

describe("isAllowed with the real robots.txt", () => {
  const allowed = (path: string) => isAllowed(real, USER_AGENT, path)

  it.each([
    "/cook/recipe/1590-Tort-Tri.html",
    "/cook/recipe/56-Salat-Mimoza.html",
    "/cook/recipe/1740-Kurinyie-serdechki.html",
    "/",
    "/sitemap.xml",
    "/robots.txt",
  ])("allows %s", (path) => {
    assert.isTrue(allowed(path))
  })

  it.each([
    "/cook/recipe/1590-Tort-Tri.html?x=1",
    "/cook/recipe/1590-Tort-Tri.html?",
    "/search.html?q=soup",
    "/gosearch.php?q=1",
    "/gogoogle.html?q=1",
    "/cdn-cgi/trace",
    "/?s=1",
  ])("forbids %s", (path) => {
    assert.isFalse(allowed(path))
  })
})

describe("isAllowed rule precedence", () => {
  it("lets the longest match win", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /a/\nAllow: /a/b/\nDisallow: /a/b/c")
    assert.isFalse(isAllowed(robots, USER_AGENT, "/a/x"))
    assert.isTrue(isAllowed(robots, USER_AGENT, "/a/b/x"))
    assert.isFalse(isAllowed(robots, USER_AGENT, "/a/b/c"))
  })

  it("lets Allow win when the matches have equal length", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page")
    assert.isTrue(isAllowed(robots, USER_AGENT, "/page"))
    const reversed = parseRobots("User-agent: *\nAllow: /page\nDisallow: /page")
    assert.isTrue(isAllowed(reversed, USER_AGENT, "/page"))
  })

  it("uses the group of the product token before the group for *", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: say7-meal-planner\nAllow: /\n"
    assert.isTrue(isAllowed(parseRobots(text), USER_AGENT, "/cook/recipe/1-A.html"))
    assert.isFalse(isAllowed(parseRobots(text), "other-bot/1.0", "/cook/recipe/1-A.html"))
  })

  it("allows everything when no group applies", () => {
    assert.isTrue(isAllowed(parseRobots("User-agent: Yandex\nDisallow: /"), USER_AGENT, "/a"))
    assert.isTrue(isAllowed(parseRobots(""), USER_AGENT, "/a"))
  })

  it("blocks all recipes when robots.txt forbids them", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /cook/recipe/")
    assert.isFalse(isAllowed(robots, USER_AGENT, "/cook/recipe/1-A.html"))
  })
})

describe("productToken", () => {
  it("cuts the version and the comment off", () => {
    assert.strictEqual(productToken(USER_AGENT), "say7-meal-planner")
    assert.strictEqual(productToken("Bot"), "bot")
  })
})
