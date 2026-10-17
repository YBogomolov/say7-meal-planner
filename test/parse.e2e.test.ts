import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { assert, describe, it } from "@effect/vitest"
import { Console, Effect, FileSystem, Layer, Option, Result, Schema } from "effect"
import { ParseReport } from "../src/domain/parse-report.ts"
import { ParsedRecipe } from "../src/domain/parsed-recipe.ts"
import { RawIndexJson } from "../src/domain/raw-index.ts"
import type { RawIndex, RawIndexEntry } from "../src/domain/raw-index.ts"
import { RecipeId } from "../src/domain/recipe.ts"
import { sha256Hex } from "../src/scraper/hash.ts"
import { formatPageLine, formatTotals, parseAll, warningSummary } from "../src/parser/run.ts"
import { parserLayer } from "../src/parser/layers.ts"
import { ParseStore } from "../src/parser/store.ts"
import { recipePage, step } from "./support/recipe-page.ts"

const id = (n: number): RecipeId => Result.getOrThrow(Schema.decodeUnknownResult(RecipeId)(n))

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const entry = (n: number, status: RawIndexEntry["status"] = "ok"): RawIndexEntry => ({
  id: id(n),
  url: `https://www.say7.info/cook/recipe/${n}-R.html`,
  lastmod: null,
  fetchedAt: "2026-01-01T00:00:00.000Z",
  status,
  httpStatus: status === "ok" ? 200 : status === "not_found" ? 404 : null,
  bytes: status === "ok" ? 10 : null,
  sha256: status === "ok" ? "f".repeat(64) : null,
  error: status === "error" ? "boom" : null,
})

const pageFor = (n: number, options: Parameters<typeof recipePage>[0] = {}): string =>
  recipePage({
    canonical: `https://www.say7.info/cook/recipe/${n}-Test.html`,
    ...options,
  })

interface Console3 {
  readonly lines: Array<string>
  readonly warnings: Array<string>
}

/** A data directory with `raw/index.json` and the given page files. The directory is removed at the end. */
const withData = <A, E>(
  setup: {
    readonly pages: Readonly<Record<number, string>>
    readonly entries: ReadonlyArray<RawIndexEntry>
  },
  use: (context: {
    readonly dataDir: string
    readonly parsedDir: string
    readonly log: Console3
  }) => Effect.Effect<A, E, FileSystem.FileSystem>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "say7-parse-" })
    yield* fs.makeDirectory(`${dataDir}/raw`, { recursive: true })
    for (const [n, html] of Object.entries(setup.pages)) {
      yield* fs.writeFileString(`${dataDir}/raw/${n}.html`, html)
    }
    const index: RawIndex = {
      version: 1,
      entries: Object.fromEntries(setup.entries.map((e) => [String(e.id), e])),
    }
    yield* fs.writeFileString(`${dataDir}/raw/index.json`, Schema.encodeSync(RawIndexJson)(index))
    const log: Console3 = { lines: [], warnings: [] }
    return yield* use({ dataDir, parsedDir: `${dataDir}/parsed`, log })
  }).pipe(Effect.provide(platform))

/** Run `parseAll` on the real file system and send the output to `log`. */
const run = (dataDir: string, log: Console3, ids: Option.Option<ReadonlySet<RecipeId>> = Option.none()) =>
  parseAll({ ids }).pipe(
    Effect.provide(parserLayer(dataDir)),
    Effect.provideService(Console.Console, {
      ...globalThis.console,
      log: (...parts: ReadonlyArray<unknown>) => void log.lines.push(parts.join(" ")),
      warn: (...parts: ReadonlyArray<unknown>) => void log.warnings.push(parts.join(" ")),
    })
  )

const readJson = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return JSON.parse(yield* fs.readFileString(path))
  })

describe("parseAll", () => {
  it.live("parses each page with status ok and writes the JSON files and the report", () =>
    withData(
      {
        pages: { 5: pageFor(5), 30: pageFor(30, { title: "Другой салат" }) },
        entries: [entry(30), entry(5), entry(77, "not_found")],
      },
      ({ parsedDir, dataDir, log }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const report = yield* run(dataDir, log)
          assert.deepStrictEqual(report.totals, {
            processed: 2,
            ok: 2,
            failed: 0,
            withWarnings: 2,
          })
          assert.deepStrictEqual((yield* fs.readDirectory(parsedDir)).sort(), ["30.json", "5.json", "_report.json"])

          const recipe = Schema.decodeUnknownSync(ParsedRecipe)(yield* readJson(`${parsedDir}/30.json`))
          assert.strictEqual(recipe.title, "Другой салат")
          assert.strictEqual(recipe.id, 30)
          assert.strictEqual(
            recipe.sourceSha256,
            sha256Hex(new TextEncoder().encode(pageFor(30, { title: "Другой салат" })))
          )

          const saved = Schema.decodeUnknownSync(ParseReport)(yield* readJson(`${parsedDir}/_report.json`))
          assert.deepStrictEqual(saved.totals, report.totals)
          assert.isTrue((yield* fs.readFileString(`${parsedDir}/5.json`)).endsWith("}\n"))
        })
    )
  )

  it.live("logs one line for each page and the number of entries", () =>
    withData(
      {
        pages: { 5: pageFor(5), 30: pageFor(30) },
        entries: [entry(5), entry(30), entry(77, "not_found")],
      },
      ({ dataDir, log }) =>
        Effect.gen(function* () {
          yield* run(dataDir, log)
          assert.strictEqual(log.lines[0], "index.json: 3 entries; 2 to parse")
          assert.deepStrictEqual(
            log.lines.slice(1).map((line) => line.split(" ").slice(0, 3).join(" ")),
            ["[1/2] 5 ok", "[2/2] 30 ok"]
          )
          assert.deepStrictEqual(log.warnings, [])
        })
    )
  )

  it.live("counts a page that fails to parse and writes no file for it", () =>
    withData(
      {
        pages: {
          5: pageFor(5),
          6: pageFor(6, { steps: null }),
          7: pageFor(7, {
            canonical: "https://www.say7.info/cook/recipe/8-X.html",
          }),
        },
        entries: [entry(5), entry(6), entry(7)],
      },
      ({ dataDir, parsedDir, log }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const report = yield* run(dataDir, log)
          assert.deepStrictEqual(report.totals, {
            processed: 3,
            ok: 1,
            failed: 2,
            withWarnings: 1,
          })
          assert.deepStrictEqual(
            report.failed.map((page) => [page.id, page.reason]),
            [
              [6, "no_steps"],
              [7, "id_mismatch"],
            ]
          )
          assert.deepStrictEqual((yield* fs.readDirectory(parsedDir)).sort(), ["5.json", "_report.json"])
          assert.isTrue(log.lines.some((line) => line.startsWith("[2/3] 6 failed no_steps")))
        })
    )
  )

  it.live("counts an unreadable page file as a failed page and goes on", () =>
    withData({ pages: { 5: pageFor(5) }, entries: [entry(4), entry(5)] }, ({ dataDir, log }) =>
      Effect.gen(function* () {
        const report = yield* run(dataDir, log)
        assert.deepStrictEqual(report.totals, {
          processed: 2,
          ok: 1,
          failed: 1,
          withWarnings: 1,
        })
        assert.deepStrictEqual(
          report.failed.map((page) => [page.id, page.reason]),
          [[4, "unreadable"]]
        )
      })
    )
  )

  it.live("removes the file of an earlier run when the page fails now", () =>
    withData({ pages: { 6: pageFor(6, { steps: null }) }, entries: [entry(6)] }, ({ dataDir, parsedDir, log }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(parsedDir, { recursive: true })
        yield* fs.writeFileString(`${parsedDir}/6.json`, "{}")
        yield* run(dataDir, log)
        assert.isFalse(yield* fs.exists(`${parsedDir}/6.json`))
      })
    )
  )

  it.live("leaves the files of pages that are not in the run", () =>
    withData(
      {
        pages: { 5: pageFor(5), 30: pageFor(30) },
        entries: [entry(5), entry(30)],
      },
      ({ dataDir, parsedDir, log }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          yield* run(dataDir, log)
          const before = yield* fs.readFileString(`${parsedDir}/5.json`)
          const report = yield* run(dataDir, { lines: [], warnings: [] }, Option.some(new Set([id(30)])))
          assert.strictEqual(report.totals.processed, 1)
          assert.strictEqual(yield* fs.readFileString(`${parsedDir}/5.json`), before)
          assert.deepStrictEqual((yield* fs.readDirectory(parsedDir)).sort(), ["30.json", "5.json", "_report.json"])
        })
    )
  )

  it.live("with --ids parses only these pages and warns about the others", () =>
    withData(
      {
        pages: { 5: pageFor(5), 30: pageFor(30) },
        entries: [entry(5), entry(30), entry(77, "not_found")],
      },
      ({ dataDir, parsedDir, log }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const report = yield* run(dataDir, log, Option.some(new Set([id(30), id(77), id(999)])))
          assert.strictEqual(report.totals.processed, 1)
          assert.deepStrictEqual((yield* fs.readDirectory(parsedDir)).sort(), ["30.json", "_report.json"])
          assert.deepStrictEqual(log.warnings, [
            "warning: IDs not in index.json: 999",
            "warning: IDs without a downloaded page (status is not ok): 77",
          ])
        })
    )
  )

  it.live("parses the same input to the same bytes", () =>
    withData({ pages: { 5: pageFor(5) }, entries: [entry(5)] }, ({ dataDir, parsedDir, log }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* run(dataDir, log)
        const first = yield* fs.readFileString(`${parsedDir}/5.json`)
        yield* run(dataDir, log)
        assert.strictEqual(yield* fs.readFileString(`${parsedDir}/5.json`), first)
      })
    )
  )

  it.live("removes a temporary file of an interrupted run and leaves none behind", () =>
    withData({ pages: { 5: pageFor(5) }, entries: [entry(5)] }, ({ dataDir, parsedDir, log }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(parsedDir, { recursive: true })
        yield* fs.writeFileString(`${parsedDir}/5.json.tmp`, "{")
        yield* run(dataDir, log)
        assert.deepStrictEqual((yield* fs.readDirectory(parsedDir)).sort(), ["5.json", "_report.json"])
      })
    )
  )

  it.live("fails with a hint when index.json does not exist", () =>
    withData({ pages: {}, entries: [] }, ({ dataDir, log }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.remove(`${dataDir}/raw/index.json`)
        const result = yield* Effect.result(run(dataDir, log))
        assert.isTrue(Result.isFailure(result) && result.failure._tag === "StoreError")
        assert.isTrue(Result.isFailure(result) && result.failure.message.includes("npm run scrape"))
      })
    )
  )

  it.live("fails when index.json is not valid", () =>
    withData({ pages: {}, entries: [] }, ({ dataDir, log }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${dataDir}/raw/index.json`, '{"version":2}')
        const result = yield* Effect.result(run(dataDir, log))
        assert.isTrue(Result.isFailure(result) && result.failure._tag === "IndexInvalidError")
      })
    )
  )

  it.live("writes an empty report for an index without pages", () =>
    withData({ pages: {}, entries: [entry(77, "not_found")] }, ({ dataDir, parsedDir, log }) =>
      Effect.gen(function* () {
        const report = yield* run(dataDir, log)
        assert.deepStrictEqual(report.totals, {
          processed: 0,
          ok: 0,
          failed: 0,
          withWarnings: 0,
        })
        Schema.decodeUnknownSync(ParseReport)(yield* readJson(`${parsedDir}/_report.json`))
      })
    )
  )

  it.live("does not change data/raw", () =>
    withData({ pages: { 5: pageFor(5) }, entries: [entry(5)] }, ({ dataDir, log }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const before = yield* fs.readFileString(`${dataDir}/raw/index.json`)
        yield* run(dataDir, log)
        assert.strictEqual(yield* fs.readFileString(`${dataDir}/raw/index.json`), before)
        assert.deepStrictEqual((yield* fs.readDirectory(`${dataDir}/raw`)).sort(), ["5.html", "index.json"])
      })
    )
  )
})

describe("ParseStore", () => {
  it.live("removeParsed does not fail when the file does not exist", () =>
    withData({ pages: {}, entries: [] }, ({ dataDir }) =>
      Effect.gen(function* () {
        const store = yield* ParseStore
        yield* store.prepare
        yield* store.removeParsed(id(404))
      }).pipe(Effect.provide(parserLayer(dataDir)))
    )
  )

  it.live("readPage fails with a StoreError for a missing file", () =>
    withData({ pages: {}, entries: [] }, ({ dataDir }) =>
      Effect.gen(function* () {
        const store = yield* ParseStore
        const result = yield* Effect.result(store.readPage(id(404)))
        assert.isTrue(Result.isFailure(result) && result.failure._tag === "StoreError")
      }).pipe(Effect.provide(parserLayer(dataDir)))
    )
  )
})

describe("output text", () => {
  const page = (n: number, warnings: ReadonlyArray<"no_servings" | "no_durations">) =>
    ({ _tag: "Parsed", id: id(n), warnings }) as const

  it("formats a line for a page", () => {
    assert.strictEqual(formatPageLine({ k: 1, n: 3, result: page(5, []) }), "[1/3] 5 ok")
    assert.strictEqual(
      formatPageLine({
        k: 2,
        n: 3,
        result: page(6, ["no_servings", "no_durations"]),
      }),
      "[2/3] 6 ok (warnings: no_servings, no_durations)"
    )
    assert.strictEqual(
      formatPageLine({
        k: 3,
        n: 3,
        result: {
          _tag: "Failed",
          id: id(7),
          reason: "no_steps",
          message: "no step",
        },
      }),
      "[3/3] 7 failed no_steps (no step)"
    )
  })

  it.live("formats the totals and the warnings of a run", () =>
    withData(
      {
        pages: {
          5: pageFor(5, { steps: step(1, "Варить 10 минут.") }),
          6: pageFor(6),
        },
        entries: [entry(5), entry(6)],
      },
      ({ dataDir, log }) =>
        Effect.gen(function* () {
          const report = yield* run(dataDir, log)
          assert.strictEqual(formatTotals(report), "parsed 2, failed 0, with warnings 1")
          assert.deepStrictEqual(warningSummary(report), ["no_durations 1"])
        })
    )
  )
})
