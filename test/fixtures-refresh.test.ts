import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { assert, describe, it } from "@effect/vitest"
import { Console, Effect, FileSystem, Layer, Path, Result, Schema } from "effect"
import { FixtureIdsJson, refreshFixtures } from "../src/parser/fixtures.ts"

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

interface Dirs {
  readonly idsFile: string
  readonly sourceDir: string
  readonly targetDir: string
}

/** A temporary directory with a list of IDs, a source directory with the given pages and an empty target path. */
const withDirs = <A, E>(
  setup: {
    readonly ids: string
    readonly pages: Readonly<Record<string, string>>
  },
  use: (dirs: Dirs, log: Array<string>) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "say7-fixtures-" })
    const dirs: Dirs = {
      idsFile: `${root}/real-ids.json`,
      sourceDir: `${root}/raw`,
      targetDir: `${root}/fixtures/real`,
    }
    yield* fs.makeDirectory(dirs.sourceDir, { recursive: true })
    yield* fs.writeFileString(dirs.idsFile, setup.ids)
    for (const [name, text] of Object.entries(setup.pages)) {
      yield* fs.writeFileString(`${dirs.sourceDir}/${name}`, text)
    }
    const log: Array<string> = []
    return yield* use(dirs, log).pipe(
      Effect.provideService(Console.Console, {
        ...globalThis.console,
        log: (...parts: ReadonlyArray<unknown>) => void log.push(parts.join(" ")),
        warn: (...parts: ReadonlyArray<unknown>) => void log.push(`warn: ${parts.join(" ")}`),
      })
    )
  }).pipe(Effect.provide(platform))

describe("FixtureIdsJson", () => {
  it("accepts a list of IDs", () => {
    assert.deepStrictEqual<ReadonlyArray<number>>(Schema.decodeUnknownSync(FixtureIdsJson)("[18,\n 38]"), [18, 38])
  })

  it.each(["[]", "[1,1]", "[0]", '["a"]', "{}", "not json"])("rejects %s", (text) => {
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(FixtureIdsJson)(text)))
  })
})

describe("refreshFixtures", () => {
  it.live("copies the listed pages and nothing else", () =>
    withDirs(
      {
        ids: "[18, 38]",
        pages: {
          "18.html": "<p>один</p>",
          "38.html": "<p>два</p>",
          "99.html": "x",
          "index.json": "{}",
        },
      },
      (dirs, log) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const summary = yield* refreshFixtures(dirs)
          assert.deepStrictEqual<ReadonlyArray<number>>(summary.copied, [18, 38])
          assert.deepStrictEqual(summary.missing, [])
          assert.deepStrictEqual((yield* fs.readDirectory(dirs.targetDir)).sort(), ["18.html", "38.html"])
          assert.strictEqual(yield* fs.readFileString(`${dirs.targetDir}/38.html`), "<p>два</p>")
          assert.deepStrictEqual(log, ["copied: 18.html", "copied: 38.html"])
        })
    )
  )

  it.live("reports a page that is missing in the source directory", () =>
    withDirs({ ids: "[18, 38]", pages: { "38.html": "x" } }, (dirs, log) =>
      Effect.gen(function* () {
        const summary = yield* refreshFixtures(dirs)
        assert.deepStrictEqual<ReadonlyArray<number>>(summary.copied, [38])
        assert.deepStrictEqual<ReadonlyArray<number>>(summary.missing, [18])
        assert.isTrue(log.some((line) => line.startsWith("warn: missing: ") && line.endsWith("18.html")))
      })
    )
  )

  it.live("replaces an older copy and leaves no temporary file", () =>
    withDirs({ ids: "[18]", pages: { "18.html": "new" } }, (dirs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(dirs.targetDir, { recursive: true })
        yield* fs.writeFileString(`${dirs.targetDir}/18.html`, "old")
        yield* fs.writeFileString(`${dirs.targetDir}/18.html.tmp`, "stale")
        yield* refreshFixtures(dirs)
        assert.strictEqual(yield* fs.readFileString(`${dirs.targetDir}/18.html`), "new")
        assert.isTrue((yield* fs.readDirectory(dirs.targetDir)).every((name) => !name.endsWith(".tmp")))
      })
    )
  )

  it.live("fails with a FixtureError when the list is not valid", () =>
    withDirs({ ids: "[1, 1]", pages: {} }, (dirs) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(refreshFixtures(dirs))
        assert.isTrue(Result.isFailure(result) && result.failure._tag === "FixtureError")
      })
    )
  )

  it.live("fails with a FixtureError when the list does not exist", () =>
    withDirs({ ids: "[1]", pages: {} }, (dirs) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(refreshFixtures({ ...dirs, idsFile: `${dirs.idsFile}.none` }))
        assert.isTrue(Result.isFailure(result) && result.failure._tag === "FixtureError")
      })
    )
  )
})
