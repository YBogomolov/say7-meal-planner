import { Effect } from "effect"
import type { Scope } from "effect"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { encodeWindows1251 } from "./win1251.ts"

export interface Reply {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Uint8Array | string
  /** Never answer. Used for time-out tests. */
  readonly hang?: boolean
}

export interface RecordedRequest {
  /** Path and query string, as sent. */
  readonly url: string
  readonly userAgent: string | undefined
}

export interface TestSite {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string
  readonly requests: ReadonlyArray<RecordedRequest>
  /** Answer `path` with the reply of `handler`. `hit` counts requests to that path from 1. */
  readonly route: (path: string, handler: (hit: number) => Reply) => void
  /** Number of requests that arrived for `path`. */
  readonly hits: (path: string) => number
}

/** A local HTTP server on 127.0.0.1 with a random port. It closes when the scope ends. */
export const startTestSite: Effect.Effect<TestSite, never, Scope.Scope> = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<TestSite & { readonly close: () => Promise<void> }>((resolve) => {
        const handlers = new Map<string, (hit: number) => Reply>()
        const counts = new Map<string, number>()
        const requests: Array<RecordedRequest> = []

        const server = createServer((request: IncomingMessage, response: ServerResponse) => {
          const url = request.url ?? "/"
          requests.push({ url, userAgent: request.headers["user-agent"] })
          const hit = (counts.get(url) ?? 0) + 1
          counts.set(url, hit)
          const handler = handlers.get(url)
          const reply: Reply = handler === undefined ? { status: 404, body: "not found" } : handler(hit)
          if (reply.hang === true) {
            return
          }
          response.writeHead(reply.status, { ...reply.headers })
          response.end(reply.body)
        })

        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          const port = typeof address === "object" && address !== null ? address.port : 0
          resolve({
            origin: `http://127.0.0.1:${port}`,
            requests,
            route: (path, handler) => {
              handlers.set(path, handler)
            },
            hits: (path) => counts.get(path) ?? 0,
            close: () =>
              new Promise<void>((done) => {
                server.closeAllConnections()
                server.close(() => done())
              }),
          })
        })
      })
  ),
  (site) => Effect.promise(() => site.close())
)

export const REAL_ROBOTS_TXT = `User-agent: *
Disallow: /cdn-cgi/
Disallow: /gogoogle.html?*
Disallow: /gosearch.php?*
Disallow: /search.html?*
Allow: /cook/recipe/*.html$
Disallow: /cook/recipe/*?
Disallow: /?*

User-agent: Yandex
Disallow: /cdn-cgi/
Disallow: /gogoogle.html?*
Disallow: /gosearch.php?*
Disallow: /search.html?*
Allow: /cook/recipe/*.html$
Disallow: /cook/recipe/*?
Disallow: /?*

Sitemap: https://www.say7.info/sitemap.xml
`

export const textReply = (contentType: string, text: string): Reply => ({
  status: 200,
  headers: { "content-type": contentType },
  body: text,
})

/** A windows-1251 page, as the real site serves it. */
export const win1251Reply = (html: string, contentType = "text/html; charset=windows-1251"): Reply => ({
  status: 200,
  headers: { "content-type": contentType },
  body: encodeWindows1251(html),
})
