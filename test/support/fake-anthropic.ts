import { Effect } from "effect"
import type { Scope } from "effect"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

/** A request that reached the fake server. */
export interface SeenRequest {
  readonly method: string
  /** Path and query string, as sent. */
  readonly url: string
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>
  /** The body as text. Empty for a GET. */
  readonly text: string
  /** The body as JSON, or `undefined` if the body is empty or not JSON. */
  readonly json: unknown
}

export interface FakeReply {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body: string
}

export const jsonReply = (value: unknown, status = 200): FakeReply => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value)
})

export interface FakeAnthropic {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string
  readonly seen: Array<SeenRequest>
  /** Answer `METHOD /path` (without the query string) with the reply of `handler`. */
  readonly route: (method: string, path: string, handler: (request: SeenRequest) => FakeReply) => void
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })

const parseJson = (text: string): unknown => {
  try {
    return text === "" ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * A local HTTP server on 127.0.0.1 that plays the Anthropic API.
 * It records each request with its headers and body. It closes when the scope ends.
 */
export const startFakeAnthropic: Effect.Effect<FakeAnthropic, never, Scope.Scope> = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<FakeAnthropic & { readonly close: () => Promise<void> }>((resolve) => {
        const handlers = new Map<string, (request: SeenRequest) => FakeReply>()
        const seen: Array<SeenRequest> = []

        const server = createServer((request: IncomingMessage, response: ServerResponse) => {
          void readBody(request).then((text) => {
            const url = request.url ?? "/"
            const entry: SeenRequest = {
              method: request.method ?? "GET",
              url,
              headers: request.headers,
              text,
              json: parseJson(text)
            }
            seen.push(entry)
            const path = url.split("?")[0] ?? url
            const handler = handlers.get(`${entry.method} ${path}`)
            const reply: FakeReply = handler === undefined
              ? { status: 404, body: `{"type":"error","error":{"type":"not_found_error","message":"no route ${entry.method} ${path}"}}` }
              : handler(entry)
            response.writeHead(reply.status ?? 200, { ...reply.headers })
            response.end(reply.body)
          })
        })

        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          const port = typeof address === "object" && address !== null ? address.port : 0
          resolve({
            origin: `http://127.0.0.1:${port}`,
            seen,
            route: (method, path, handler) => {
              handlers.set(`${method} ${path}`, handler)
            },
            close: () =>
              new Promise<void>((done) => {
                server.closeAllConnections()
                server.close(() => done())
              })
          })
        })
      })
  ),
  (site) => Effect.promise(() => site.close())
)
