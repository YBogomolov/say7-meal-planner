import { Schema } from "effect"

/** Positive integer recipe ID, as used in `/cook/recipe/<id>-<slug>.html`. */
export const RecipeId = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.brand("RecipeId"))
export type RecipeId = typeof RecipeId.Type

/** Calendar date in the form `YYYY-MM-DD`, as used by `<lastmod>` in the sitemap. */
export const IsoDate = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
      message: "Expected a date in the form YYYY-MM-DD",
    })
  )
)
export type IsoDate = typeof IsoDate.Type

/** UTC timestamp in ISO 8601 form, for example `2026-10-12T13:07:41.123Z`. */
export const IsoTimestamp = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, {
      message: "Expected a UTC timestamp in ISO 8601 form",
    })
  )
)
export type IsoTimestamp = typeof IsoTimestamp.Type

/** One recipe URL from `sitemap.xml`. */
export const SitemapEntry = Schema.Struct({
  id: RecipeId,
  url: Schema.String,
  slug: Schema.NonEmptyString,
  lastmod: Schema.Option(IsoDate),
})
export type SitemapEntry = typeof SitemapEntry.Type
