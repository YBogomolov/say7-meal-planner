import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, PlatformError, Result, Schema } from "effect"
import type { RawIndex, RawIndexEntry } from "../src/domain/raw-index.ts"
import { RawIndexJson } from "../src/domain/raw-index.ts"
import { RecipeId } from "../src/domain/recipe.ts"
import { RawStore } from "../src/scraper/store.ts"

const id = (n: number): RecipeId => Result.getOrThrow(Schema.decodeUnknownResult(RecipeId)(n))

const entry = (n: number): RawIndexEntry => ({
  id: id(n),
  url: `https://www.say7.info/cook/recipe/${n}-R.html`,
  lastmod: "2025-01-01",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  status: "ok",
  httpStatus: 200,
  bytes: 10,
  sha256: "f".repeat(64),
  error: null
})

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** A temporary data directory and a store on it. The directory is removed at the end. */
const withStore = <A, E>(use: (context: { readonly dataDir: string; readonly rawDir: string }) => Effect.Effect<A, E, RawStore | FileSystem.FileSystem>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "say7-store-" })
    return yield* use({ dataDir, rawDir: `${dataDir}/raw` }).pipe(Effect.provide(RawStore.layer(dataDir)))
  }).pipe(Effect.provide(platform))

describe("RawStore", () => {
  it.live("creates data/raw and starts with an empty index", () =>
    withStore(({ rawDir }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const contents = yield* RawStore.use((store) => store.load)
        assert.deepStrictEqual(contents.index, { version: 1, entries: {} })
        assert.strictEqual(contents.pageIds.size, 0)
        assert.isTrue(yield* fs.exists(rawDir))
      })
    ))

  it.live("writes a page as UTF-8 and reads the ID back", () =>
    withStore(({ rawDir }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const store = yield* RawStore
        yield* store.load
        yield* store.savePage(id(1740), "<p>Куриные сердечки</p>")
        const bytes = yield* fs.readFile(`${rawDir}/1740.html`)
        assert.strictEqual(new TextDecoder("utf-8", { fatal: true }).decode(bytes), "<p>Куриные сердечки</p>")
        const names = yield* fs.readDirectory(rawDir)
        assert.deepStrictEqual(names, ["1740.html"])
        const again = yield* store.load
        assert.deepStrictEqual([...again.pageIds], [1740])
      })
    ))

  it.live("saves and loads the index", () =>
    withStore(({ rawDir }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const store = yield* RawStore
        const index: RawIndex = { version: 1, entries: { "5": entry(5), "30": entry(30) } }
        yield* store.saveIndex(index)
        const text = yield* fs.readFileString(`${rawDir}/index.json`)
        assert.isTrue(text.endsWith("\n"))
        assert.deepStrictEqual(Schema.decodeUnknownSync(RawIndexJson)(text), index)
        assert.deepStrictEqual((yield* store.load).index, index)
      })
    ))

  it.live("overwrites an existing page and leaves no temporary file", () =>
    withStore(({ rawDir }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const store = yield* RawStore
        yield* store.load
        yield* store.savePage(id(7), "old")
        yield* store.savePage(id(7), "new")
        assert.strictEqual(yield* fs.readFileString(`${rawDir}/7.html`), "new")
        assert.deepStrictEqual(yield* fs.readDirectory(rawDir), ["7.html"])
      })
    ))

  it.live("removes leftovers of an interrupted write when it loads", () =>
    withStore(({ rawDir }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const store = yield* RawStore
        yield* store.load
        yield* fs.writeFileString(`${rawDir}/9.html.tmp`, "half")
        yield* fs.writeFileString(`${rawDir}/index.json.tmp`, "{")
        yield* fs.writeFileString(`${rawDir}/9.html`, "whole")
        const contents = yield* store.load
        assert.deepStrictEqual((yield* fs.readDirectory(rawDir)).toSorted(), ["9.html"])
        assert.deepStrictEqual([...contents.pageIds], [9])
      })
    ))

  it.live("ignores files that are not pages", () =>
    withStore(({ rawDir }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const store = yield* RawStore
        yield* store.load
        yield* fs.writeFileString(`${rawDir}/notes.txt`, "x")
        yield* fs.writeFileString(`${rawDir}/0.html`, "x")
        yield* fs.writeFileString(`${rawDir}/12.html`, "x")
        assert.deepStrictEqual([...(yield* store.load).pageIds], [12])
      })
    ))

  it.live("refuses a broken index.json and leaves it untouched", () =>
    withStore(({ rawDir }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const store = yield* RawStore
        yield* store.load
        yield* fs.writeFileString(`${rawDir}/index.json`, "{ not json")
        const error = yield* Effect.flip(store.load)
        assert.strictEqual(error._tag, "IndexInvalidError")
        assert.strictEqual(yield* fs.readFileString(`${rawDir}/index.json`), "{ not json")
      })
    ))

  it.live("refuses an index whose keys do not match the IDs", () =>
    withStore(({ rawDir }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const store = yield* RawStore
        yield* store.load
        yield* fs.writeFileString(`${rawDir}/index.json`, JSON.stringify({ version: 1, entries: { "6": entry(5) } }))
        assert.strictEqual((yield* Effect.flip(store.load))._tag, "IndexInvalidError")
      })
    ))

  it.live("keeps the old file when the rename fails, and removes the temporary file", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "say7-store-" })
      const rawDir = `${dataDir}/raw`

      const store = yield* RawStore.use((s) => Effect.succeed(s)).pipe(Effect.provide(RawStore.layer(dataDir)))
      yield* store.load
      yield* store.savePage(id(3), "version 1")

      const failingRename = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) => ({
          ...real,
          rename: () =>
            Effect.fail(
              PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "rename" })
            )
        }))
      ).pipe(Layer.provide(NodeFileSystem.layer))
      const brokenStore = yield* RawStore.use((s) => Effect.succeed(s)).pipe(
        Effect.provide(RawStore.layer(dataDir).pipe(Layer.provide(Layer.mergeAll(failingRename, NodePath.layer))))
      )

      const error = yield* Effect.flip(brokenStore.savePage(id(3), "version 2"))
      assert.strictEqual(error._tag, "StoreError")
      assert.strictEqual(yield* fs.readFileString(`${rawDir}/3.html`), "version 1")
      assert.deepStrictEqual(yield* fs.readDirectory(rawDir), ["3.html"])
    }).pipe(Effect.provide(platform)))
})
