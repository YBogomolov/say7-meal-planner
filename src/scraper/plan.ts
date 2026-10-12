import { Option } from "effect"
import type { RawIndex, RawIndexEntry } from "../domain/raw-index.ts"
import type { RecipeId, SitemapEntry } from "../domain/recipe.ts"

export type FetchReason =
  /** No index entry for this ID. */
  | "new"
  /** The sitemap `lastmod` differs from the `lastmod` in the index. */
  | "changed"
  /** The index entry is `ok`, but the HTML file is missing. */
  | "missing_file"
  /** The last attempt ended with `error`, or with `not_found` and the sitemap `lastmod` is missing or different. */
  | "retry"
  /** The flag `--force` is on. */
  | "forced"

export interface PlannedFetch {
  readonly entry: SitemapEntry
  readonly reason: FetchReason
}

export interface PlanInput {
  readonly entries: ReadonlyArray<SitemapEntry>
  readonly index: RawIndex
  /** IDs that have a file `<id>.html` in the raw directory. */
  readonly existingFiles: ReadonlySet<RecipeId>
  readonly force: boolean
  /** Only these IDs. `None` means all IDs of the sitemap. */
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
  /** Keep only the first n entries that need a fetch. */
  readonly limit: Option.Option<number>
}

export interface FetchPlan {
  /** Entries to fetch, in sitemap order. */
  readonly toFetch: ReadonlyArray<PlannedFetch>
  /** Entries in scope that the cache already covers. */
  readonly skipped: number
  /** Entries that need a fetch but fall outside `limit`. */
  readonly deferred: number
  /** Requested IDs that are not in the sitemap. */
  readonly unknownIds: ReadonlyArray<RecipeId>
}

/**
 * Decide if one entry needs a fetch (spec P1.4, with the rule for `not_found` from the coordinator).
 * - `--force`: fetch.
 * - No index entry: fetch.
 * - Status `error`: fetch again on every run.
 * - Status `not_found`: skip when the sitemap has a `lastmod` and it is the same as in the index.
 *   Fetch again when the `lastmod` is different or missing from the sitemap.
 * - Status `ok`: skip when the HTML file exists and the `lastmod` is the same.
 *   If the sitemap has no `lastmod`, any `ok` entry with a file is enough.
 */
export const decideFetch = (
  entry: SitemapEntry,
  cached: Option.Option<RawIndexEntry>,
  fileExists: boolean,
  force: boolean
): Option.Option<FetchReason> => {
  if (force) {
    return Option.some("forced")
  }
  if (Option.isNone(cached)) {
    return Option.some("new")
  }
  const known = cached.value
  if (known.status === "error") {
    return Option.some("retry")
  }
  if (known.status === "not_found") {
    const sameLastmod = Option.isSome(entry.lastmod) && entry.lastmod.value === known.lastmod
    return sameLastmod ? Option.none() : Option.some("retry")
  }
  if (!fileExists) {
    return Option.some("missing_file")
  }
  if (Option.isSome(entry.lastmod) && entry.lastmod.value !== known.lastmod) {
    return Option.some("changed")
  }
  return Option.none()
}

export const planFetches = (input: PlanInput): FetchPlan => {
  const wanted = input.ids
  const inScope = Option.isSome(wanted)
    ? input.entries.filter((entry) => wanted.value.has(entry.id))
    : input.entries

  const needed: Array<PlannedFetch> = []
  let skipped = 0
  for (const entry of inScope) {
    const cached = Option.fromNullishOr(input.index.entries[String(entry.id)])
    const reason = decideFetch(entry, cached, input.existingFiles.has(entry.id), input.force)
    if (Option.isSome(reason)) {
      needed.push({ entry, reason: reason.value })
    } else {
      skipped += 1
    }
  }

  const toFetch = Option.isSome(input.limit) ? needed.slice(0, input.limit.value) : needed
  const inSitemap = new Set(input.entries.map((entry) => entry.id))
  const unknownIds = Option.isSome(wanted) ? [...wanted.value].filter((id) => !inSitemap.has(id)) : []

  return { toFetch, skipped, deferred: needed.length - toFetch.length, unknownIds }
}
