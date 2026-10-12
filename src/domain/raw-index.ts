import { Schema } from "effect"
import { IsoDate, IsoTimestamp, RecipeId } from "./recipe.ts"

export const RawStatus = Schema.Literals(["ok", "not_found", "error"])
export type RawStatus = typeof RawStatus.Type

/** What the scraper knows about one recipe page. Stored in `data/raw/index.json`. */
export const RawIndexEntry = Schema.Struct({
  id: RecipeId,
  url: Schema.String,
  lastmod: Schema.NullOr(IsoDate),
  fetchedAt: IsoTimestamp,
  status: RawStatus,
  httpStatus: Schema.NullOr(Schema.Int),
  bytes: Schema.NullOr(Schema.Natural),
  sha256: Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)))),
  error: Schema.NullOr(Schema.String)
})
export type RawIndexEntry = typeof RawIndexEntry.Type

const entryKeysMatchIds = Schema.makeFilter<{
  readonly entries: { readonly [key: string]: RawIndexEntry }
}>((index) =>
  Object.entries(index.entries).every(([key, entry]) => key === String(entry.id)) ||
  "Every key of `entries` must equal the `id` of its entry"
)

/** The whole `data/raw/index.json` file. `entries` is keyed by the recipe ID as a string. */
export const RawIndex = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Record(Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9]\d*$/))), RawIndexEntry)
}).pipe(Schema.check(entryKeysMatchIds))
export type RawIndex = typeof RawIndex.Type

export const emptyRawIndex: RawIndex = { version: 1, entries: {} }

/** JSON text codec for `index.json`. */
export const RawIndexJson = Schema.fromJsonString(RawIndex, { space: 2 })
