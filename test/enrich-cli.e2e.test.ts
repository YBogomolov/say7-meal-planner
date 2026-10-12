import { execFile } from "node:child_process"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { EnrichedRecipeJson } from "../src/domain/enriched-recipe.ts"
import { EnrichReportJson } from "../src/domain/enrich-report.ts"
import { jsonReply, startFakeAnthropic } from "./support/fake-anthropic.ts"
import { enrichmentFor, parsedRecipe, SALADS, withEnrichDirs } from "./support/enrich.ts"

/** The real command `src/enrich/cli.ts`, in a child process, against a fake API on 127.0.0.1. No test uses the real API. */

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))
const CLI = fileURLToPath(new URL("../src/enrich/cli.ts", import.meta.url))
const KEY = "sk-ant-api03-E2EKEY0123456789abcdefXYZ"
const SLOW_TEST_MS = 90_000

interface Finished {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The environment of the test process without any ANTHROPIC_ variable, so that a key of the developer cannot reach the test. */
const cleanEnv = (extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ANTHROPIC_"))),
  ...extra
})

const runCli = (args: ReadonlyArray<string>, cwd: string, env: NodeJS.ProcessEnv): Effect.Effect<Finished> =>
  Effect.promise(
    () =>
      new Promise<Finished>((resolve) => {
        execFile(TSX, [CLI, ...args], { cwd, env, timeout: 80_000 }, (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1
          resolve({ code, stdout, stderr })
        })
      })
  )

const recipes = [1, 2].map((n) => parsedRecipe(n))

describe("npm run enrich, as a child process", () => {
  it.live("reads the key from .env, sends the requests to the API, stores the files and prints no key", () =>
    withEnrichDirs(recipes, (ctx) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const api = yield* startFakeAnthropic
        api.route("POST", "/v1/messages", () =>
          jsonReply({
            id: "msg_e2e",
            type: "message",
            role: "assistant",
            model: "claude-haiku-5-5",
            content: [{ type: "text", text: JSON.stringify(enrichmentFor(2)) }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1000, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
          }))
        const cwd = dirname(ctx.dataDir)
        yield* fs.writeFileString(`${cwd}/.env`, `ANTHROPIC_API_KEY=${KEY}\n`)

        const finished = yield* runCli(
          ["--model", "claude-haiku-5-5", "--sync", "--data-dir", ctx.dataDir],
          cwd,
          cleanEnv({ ANTHROPIC_BASE_URL: api.origin })
        )

        assert.strictEqual(finished.code, 0, finished.stderr)
        assert.include(finished.stdout, "done: processed 2, succeeded 2, failed 0, cached 0")
        assert.notInclude(finished.stdout + finished.stderr, KEY)

        // The key of the .env file went to the API in the header x-api-key, and nowhere else.
        assert.lengthOf(api.seen, 2)
        assert.isTrue(api.seen.every((seen) => seen.headers["x-api-key"] === KEY))
        assert.isTrue(api.seen.every((seen) => seen.url === "/v1/messages"))

        const stored = Schema.decodeUnknownSync(EnrichedRecipeJson)(yield* fs.readFileString(`${ctx.outDir}/1.json`))
        assert.strictEqual(stored.model, "claude-haiku-5-5")
        assert.strictEqual(stored.id, 1)
        const report = Schema.decodeUnknownSync(EnrichReportJson)(yield* fs.readFileString(`${ctx.outDir}/_report.json`))
        assert.deepStrictEqual(
          { processed: report.totals.processed, succeeded: report.totals.succeeded, mode: report.mode },
          { processed: 2, succeeded: 2, mode: "sync" }
        )
        for (const name of yield* fs.readDirectory(ctx.outDir)) {
          assert.notInclude(yield* fs.readFileString(`${ctx.outDir}/${name}`), KEY, name)
        }
      })), SLOW_TEST_MS)

  it.live("stops with a clear message and writes nothing when there is no key", () =>
    withEnrichDirs(recipes, (ctx) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const api = yield* startFakeAnthropic
        const finished = yield* runCli(
          ["--model", "claude-haiku-5-5", "--data-dir", ctx.dataDir],
          dirname(ctx.dataDir),
          cleanEnv({ ANTHROPIC_BASE_URL: api.origin })
        )
        assert.strictEqual(finished.code, 1)
        assert.include(finished.stderr, "The variable ANTHROPIC_API_KEY is not set")
        assert.lengthOf(api.seen, 0)
        assert.isFalse(yield* fs.exists(ctx.outDir))
      })), SLOW_TEST_MS)

  it.live("stops at once with exit code 1 on a wrong key, and the message has no key", () =>
    withEnrichDirs(recipes, (ctx) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const api = yield* startFakeAnthropic
        api.route("POST", "/v1/messages", () =>
          jsonReply(
            { type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${KEY}` }, request_id: "req_1" },
            401
          ))
        const finished = yield* runCli(
          ["--model", "claude-haiku-5-5", "--sync", "--data-dir", ctx.dataDir],
          dirname(ctx.dataDir),
          cleanEnv({ ANTHROPIC_BASE_URL: api.origin, ANTHROPIC_API_KEY: KEY })
        )
        assert.strictEqual(finished.code, 1)
        assert.include(finished.stderr, "error:")
        assert.include(finished.stderr, "authentication_error")
        assert.notInclude(finished.stdout + finished.stderr, KEY)
        assert.isFalse(yield* fs.exists(`${ctx.outDir}/1.json`))
        assert.isFalse(yield* fs.exists(`${ctx.outDir}/_report.json`))
      })), SLOW_TEST_MS)

  it.live("--dry-run needs no key and no model, sends no request and writes no file", () =>
    withEnrichDirs([...recipes, parsedRecipe(3, { categories: [SALADS] })], (ctx) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const api = yield* startFakeAnthropic
        const finished = yield* runCli(
          ["--dry-run", "--data-dir", ctx.dataDir],
          dirname(ctx.dataDir),
          cleanEnv({ ANTHROPIC_BASE_URL: api.origin })
        )
        assert.strictEqual(finished.code, 0, finished.stderr)
        const lines = finished.stdout.split("\n")
        assert.include(lines, "parsed files: 3, unreadable 0, out of scope 0, in scope 3")
        assert.include(lines, "requests: 3 (a real run uses sync mode)")
        assert.isTrue(lines.some((line) => /^\s+claude-haiku-5-5\s/.test(line)))
        assert.isTrue(lines.some((line) => /^\s+claude-sonnet-5-5\s/.test(line)))
        assert.lengthOf(api.seen, 0)
        assert.isFalse(yield* fs.exists(ctx.outDir))
      })), SLOW_TEST_MS)

  it.live("--dry-run exits with 1 when a request is not valid", () =>
    withEnrichDirs([parsedRecipe(1)], (ctx) =>
      Effect.gen(function*() {
        // A parsed file that is valid for the schema but has an empty ingredient line breaks the check of the request.
        const fs = yield* FileSystem.FileSystem
        const text = yield* fs.readFileString(`${ctx.dataDir}/parsed/1.json`)
        yield* fs.writeFileString(`${ctx.dataDir}/parsed/1.json`, text.replace("200 г моркови", " "))
        const finished = yield* runCli(["--dry-run", "--data-dir", ctx.dataDir], dirname(ctx.dataDir), cleanEnv({}))
        assert.strictEqual(finished.code, 1)
        assert.include(finished.stdout, "validation: 2 problems")
        assert.include(finished.stdout, "the title or an ingredient line is empty")
      })), SLOW_TEST_MS)
})
