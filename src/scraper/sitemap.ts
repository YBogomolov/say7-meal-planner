import { Option, Result, Schema } from "effect"
import { IsoDate, SitemapEntry } from "../domain/recipe.ts"

export class SitemapError extends Schema.TaggedError<SitemapError>()("SitemapError", {
  message: Schema.String
}) {}

/** Path of a recipe page: `/cook/recipe/<id>-<slug>.html`. No query string, no fragment. */
export const RECIPE_PATH = /^\/cook\/recipe\/(\d+)-([^/?#]+)\.html$/

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'"
}

const xmlText = (raw: string): string => {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw)
  const text = cdata?.[1] ?? raw
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (whole, name: string) => XML_ENTITIES[name] ?? whole).trim()
}

const childText = (block: string, tag: "loc" | "lastmod"): Option.Option<string> => {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block)
  return Option.fromNullishOr(match?.[1]).pipe(Option.map(xmlText))
}

/**
 * Turn one `<loc>` (and optional `<lastmod>`) into a recipe entry.
 * Return `None` when the URL is not a recipe page (D1, D2): other path, query string, fragment.
 * An invalid `<lastmod>` becomes `None`.
 */
export const toSitemapEntry = (loc: string, lastmod: Option.Option<string>): Option.Option<SitemapEntry> => {
  if (loc.includes("?") || loc.includes("#") || !URL.canParse(loc)) {
    return Option.none()
  }
  const url = new URL(loc)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Option.none()
  }
  const match = RECIPE_PATH.exec(url.pathname)
  const digits = match?.[1]
  const slug = match?.[2]
  if (digits === undefined || slug === undefined) {
    return Option.none()
  }
  const entry = {
    id: Number(digits),
    url: url.href,
    slug,
    lastmod: lastmod.pipe(Option.flatMap((text) => Schema.decodeUnknownOption(IsoDate)(text)))
  }
  return Result.getSuccess(Schema.decodeUnknownResult(SitemapEntry)(entry))
}

/**
 * Parse sitemap XML text. Keep only recipe URLs, in document order.
 * If an ID occurs more than once, keep the first occurrence.
 * Fail when the text has no `<urlset>` element (for example an HTML error page).
 */
export const parseSitemap = (xml: string): Result.Result<ReadonlyArray<SitemapEntry>, SitemapError> => {
  if (!/<urlset[\s>]/.test(xml)) {
    return Result.fail(new SitemapError({ message: "The sitemap has no <urlset> element" }))
  }
  const seen = new Set<number>()
  const entries: Array<SitemapEntry> = []
  for (const block of xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/g)) {
    const body = block[1] ?? ""
    const entry = childText(body, "loc").pipe(
      Option.flatMap((loc) => toSitemapEntry(loc, childText(body, "lastmod")))
    )
    if (Option.isSome(entry) && !seen.has(entry.value.id)) {
      seen.add(entry.value.id)
      entries.push(entry.value)
    }
  }
  return Result.succeed(entries)
}

/** Path of a sitemap entry, for example `/cook/recipe/56-Salat-Mimoza.html`. */
export const recipePath = (entry: SitemapEntry): string =>
  URL.canParse(entry.url) ? new URL(entry.url).pathname : `/cook/recipe/${entry.id}-${entry.slug}.html`
