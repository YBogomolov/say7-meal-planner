import { Option, Result } from "effect"
import type { RawIndexEntry } from "../domain/raw-index.ts"
import type { IsoTimestamp, SitemapEntry } from "../domain/recipe.ts"
import { sha256Hex } from "./hash.ts"
import { describeFailure } from "./http.ts"
import type { HttpFailure, HttpResponse } from "./http.ts"

/** Result of one page request, after retries. */
export type PageOutcome =
  | {
    readonly _tag: "Fetched"
    readonly httpStatus: number
    readonly bytes: number
    readonly sha256: string
  }
  | { readonly _tag: "NotFound" }
  | {
    readonly _tag: "Failed"
    readonly httpStatus: Option.Option<number>
    readonly message: string
  }

/**
 * Sort the result of a page request into an outcome (spec P1.5, P1.6).
 * A 404 is `NotFound`. Every other failure, and an empty 200 response, is `Failed`.
 * The response is present only for a fetched page.
 */
export const classifyResult = (
  result: Result.Result<HttpResponse, HttpFailure>
): { readonly outcome: PageOutcome; readonly page: Option.Option<HttpResponse> } => {
  if (Result.isSuccess(result)) {
    const response = result.success
    return response.body.length === 0
      ? {
        outcome: { _tag: "Failed", httpStatus: Option.some(response.status), message: "Empty response body" },
        page: Option.none()
      }
      : {
        outcome: {
          _tag: "Fetched",
          httpStatus: response.status,
          bytes: response.body.length,
          sha256: sha256Hex(response.body)
        },
        page: Option.some(response)
      }
  }
  const failure = result.failure
  if (failure._tag === "HttpStatusError" && failure.status === 404) {
    return { outcome: { _tag: "NotFound" }, page: Option.none() }
  }
  return {
    outcome: {
      _tag: "Failed",
      httpStatus: failure._tag === "HttpStatusError" ? Option.some(failure.status) : Option.none(),
      message: describeFailure(failure)
    },
    page: Option.none()
  }
}

/**
 * The index entry to store after a page request.
 *
 * A failed refetch keeps an earlier `ok` entry when its HTML file is still on disk.
 * The file is still valid, and the next run fetches the page again because the `lastmod` differs.
 */
export const toIndexEntry = (
  entry: SitemapEntry,
  previous: Option.Option<RawIndexEntry>,
  previousFileExists: boolean,
  outcome: PageOutcome,
  fetchedAt: IsoTimestamp
): RawIndexEntry => {
  const base = { id: entry.id, url: entry.url, lastmod: Option.getOrNull(entry.lastmod), fetchedAt }
  switch (outcome._tag) {
    case "Fetched":
      return {
        ...base,
        status: "ok",
        httpStatus: outcome.httpStatus,
        bytes: outcome.bytes,
        sha256: outcome.sha256,
        error: null
      }
    case "NotFound":
      return { ...base, status: "not_found", httpStatus: 404, bytes: null, sha256: null, error: null }
    case "Failed": {
      if (Option.isSome(previous) && previous.value.status === "ok" && previousFileExists) {
        return previous.value
      }
      return {
        ...base,
        status: "error",
        httpStatus: Option.getOrNull(outcome.httpStatus),
        bytes: null,
        sha256: null,
        error: outcome.message
      }
    }
  }
}
