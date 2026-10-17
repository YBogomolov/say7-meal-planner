import { Option } from "effect"
import type { RawIndex } from "../domain/raw-index.ts"
import type { RecipeId } from "../domain/recipe.ts"

export interface ParsePlan {
  /** The pages to parse, in ascending ID order. */
  readonly toParse: ReadonlyArray<RecipeId>
  /** Requested IDs that `index.json` does not know. */
  readonly unknownIds: ReadonlyArray<RecipeId>
  /** Requested IDs whose status is not `ok`: there is no page to parse. */
  readonly notOkIds: ReadonlyArray<RecipeId>
}

/**
 * Decide which pages to parse (spec P2, rule 1): the entries with status `ok`.
 * With `ids`, only the entries in that set.
 */
export const planParse = (index: RawIndex, ids: Option.Option<ReadonlySet<RecipeId>>): ParsePlan => {
  const entries = Object.values(index.entries)
  const ok = entries
    .filter((entry) => entry.status === "ok")
    .map((entry) => entry.id)
    .toSorted((a, b) => a - b)

  if (Option.isNone(ids)) {
    return { toParse: ok, unknownIds: [], notOkIds: [] }
  }
  const wanted = ids.value
  const known = new Set(entries.map((entry) => entry.id))
  const okSet = new Set(ok)
  const requested = [...wanted].toSorted((a, b) => a - b)
  return {
    toParse: ok.filter((id) => wanted.has(id)),
    unknownIds: requested.filter((id) => !known.has(id)),
    notOkIds: requested.filter((id) => known.has(id) && !okSet.has(id)),
  }
}
