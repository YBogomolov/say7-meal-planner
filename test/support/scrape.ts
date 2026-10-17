import { Console, Duration, Effect } from "effect"
import type { Scope } from "effect"
import { makeScrapeCommand } from "../../src/scraper/cli-options.ts"
import type { CliOptions } from "../../src/scraper/cli-options.ts"
import { USER_AGENT } from "../../src/scraper/http.ts"
import type { HttpConfig } from "../../src/scraper/http.ts"
import { scraperLayer } from "../../src/scraper/layers.ts"
import { scrape } from "../../src/scraper/run.ts"
import type { ScrapeSummary } from "../../src/scraper/run.ts"
import { commandTester } from "./cli.ts"
import { REAL_ROBOTS_TXT, startTestSite, textReply, win1251Reply } from "./site.ts"
import type { TestSite } from "./site.ts"
import { encodeWindows1251 } from "./win1251.ts"

/** Short back-off and time limit, so that retry tests run fast. */
export const fastHttp: HttpConfig = {
  userAgent: USER_AGENT,
  timeout: Duration.seconds(2),
  retryBase: Duration.millis(5),
}

export interface RecipeFixture {
  readonly id: number
  readonly slug: string
  readonly lastmod: string | null
  readonly title: string
  /** How the server announces the charset of the page. */
  readonly charsetHint: "header" | "meta" | "none"
}

export const TORT: RecipeFixture = {
  id: 1590,
  slug: "Tort-Tri",
  lastmod: "2025-10-20",
  title: "Торт «Три шоколада»",
  charsetHint: "header",
}
export const SALAT: RecipeFixture = {
  id: 56,
  slug: "Salat-Mimoza",
  lastmod: "2026-03-11",
  title: "Салат Мимоза",
  charsetHint: "meta",
}
export const SERDECHKI: RecipeFixture = {
  id: 1740,
  slug: "Kurinyie-serdechki",
  lastmod: null,
  title: "Куриные сердечки",
  charsetHint: "none",
}
export const RECIPES: ReadonlyArray<RecipeFixture> = [TORT, SALAT, SERDECHKI]

export const pagePath = (recipe: RecipeFixture): string => `/cook/recipe/${recipe.id}-${recipe.slug}.html`

/** The page text before it is encoded to windows-1251. */
export const recipeHtml = (recipe: RecipeFixture): string => {
  const meta =
    recipe.charsetHint === "meta" ? `<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">` : ""
  return (
    `<!DOCTYPE html>\n<html><head>${meta}<title>${recipe.title}</title></head>` +
    `<body><h1>${recipe.title}</h1><p>Ёж, ёлка и № 5 — вкусно.</p></body></html>\n`
  )
}

/** The original bytes that the server sends. */
export const recipeBytes = (recipe: RecipeFixture): Uint8Array => encodeWindows1251(recipeHtml(recipe))

/**
 * Sitemap in the format of the real one: the home page, recipes with the real origin,
 * and two URLs that the scraper must ignore (search page with a query, image).
 */
export const sitemapXml = (recipes: ReadonlyArray<RecipeFixture>): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n\n` +
  `<url><loc>https://www.say7.info/</loc></url>\n\n` +
  `<url><loc>https://www.say7.info/search.html?q=%D1%81%D1%83%D0%BF</loc></url>\n\n` +
  `<url><loc>https://www.say7.info/cook/recipe/img/1590.jpg</loc></url>\n\n` +
  recipes
    .map(
      (recipe) =>
        `<url><loc>https://www.say7.info${pagePath(recipe)}</loc>\n` +
        (recipe.lastmod === null ? "" : `<lastmod>${recipe.lastmod}</lastmod>\n`) +
        `</url>\n`
    )
    .join("\n") +
  `\n</urlset>\n`

export const routeRecipe = (site: TestSite, recipe: RecipeFixture): void => {
  const contentType = recipe.charsetHint === "header" ? "text/html; charset=windows-1251" : "text/html"
  site.route(pagePath(recipe), () => win1251Reply(recipeHtml(recipe), contentType))
}

export const routeSitemap = (site: TestSite, recipes: ReadonlyArray<RecipeFixture>): void => {
  site.route("/sitemap.xml", () => textReply("text/xml; charset=utf-8", sitemapXml(recipes)))
}

export const routeRobots = (site: TestSite, text: string = REAL_ROBOTS_TXT): void => {
  site.route("/robots.txt", () => ({
    status: 200,
    headers: { "content-type": "text/plain; charset=windows-1251" },
    body: encodeWindows1251(text),
  }))
}

/** A site with the real robots.txt, a sitemap and one page per recipe. */
export const startRecipeSite = (
  recipes: ReadonlyArray<RecipeFixture> = RECIPES
): Effect.Effect<TestSite, never, Scope.Scope> =>
  Effect.gen(function* () {
    const site = yield* startTestSite
    routeRobots(site)
    routeSitemap(site, recipes)
    for (const recipe of recipes) {
      routeRecipe(site, recipe)
    }
    return site
  })

/** What the program wrote with `Console`. */
export interface ConsoleLog {
  readonly lines: Array<string>
  readonly warnings: Array<string>
  readonly errors: Array<string>
}

export const newConsoleLog = (): ConsoleLog => ({
  lines: [],
  warnings: [],
  errors: [],
})

/**
 * Run the scraper like the command line does: parse the flags, use the real layers,
 * and send the output to `log`. The delay between requests is 0 unless the flags set it.
 */
export const scrapeWith = (
  site: TestSite,
  dataDir: string,
  args: ReadonlyArray<string> = [],
  log: ConsoleLog = newConsoleLog()
) => {
  const capture = {
    ...globalThis.console,
    log: (...parts: ReadonlyArray<unknown>) => void log.lines.push(parts.join(" ")),
    warn: (...parts: ReadonlyArray<unknown>) => void log.warnings.push(parts.join(" ")),
    error: (...parts: ReadonlyArray<unknown>) => void log.errors.push(parts.join(" ")),
  }
  return Effect.gen(function* () {
    const options = yield* commandTester<CliOptions>()(makeScrapeCommand).parsed([
      ...(args.includes("--delay-ms") ? [] : ["--delay-ms", "0"]),
      ...args,
      "--base-url",
      site.origin,
      "--data-dir",
      dataDir,
    ])
    return yield* scrape(options).pipe(Effect.provide(scraperLayer({ ...options, http: fastHttp })))
  }).pipe(Effect.provideService(Console.Console, capture))
}

export const summaryOf = (fetched: number, skipped: number, notFound = 0, errors = 0, deferred = 0): ScrapeSummary => ({
  fetched,
  skipped,
  notFound,
  errors,
  deferred,
})
