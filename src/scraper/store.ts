import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { emptyRawIndex, RawIndexJson } from "../domain/raw-index.ts"
import type { RawIndex } from "../domain/raw-index.ts"
import { RecipeId } from "../domain/recipe.ts"

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  path: Schema.String,
  message: Schema.String
}) {}

/** `index.json` exists but is not valid. The scraper never overwrites it. */
export class IndexInvalidError extends Schema.TaggedError<IndexInvalidError>()("IndexInvalidError", {
  path: Schema.String,
  message: Schema.String
}) {}

export interface StoreContents {
  readonly index: RawIndex
  /** IDs that have a file `<id>.html`. */
  readonly pageIds: ReadonlySet<RecipeId>
}

const PAGE_FILE = /^(\d+)\.html$/
const TEMP_SUFFIX = ".tmp"

/** `data/raw/`: one UTF-8 HTML file per recipe, plus `index.json`. */
export class RawStore extends Context.Service<RawStore, {
  /** Create the directory, remove leftovers of an interrupted write, and read the index and the file list. */
  readonly load: Effect.Effect<StoreContents, StoreError | IndexInvalidError>
  /** Write `<id>.html` atomically. */
  readonly savePage: (id: RecipeId, html: string) => Effect.Effect<void, StoreError>
  /** Write `index.json` atomically. */
  readonly saveIndex: (index: RawIndex) => Effect.Effect<void, StoreError>
}>()("say7/scraper/RawStore") {
  static readonly layer = (dataDir: string): Layer.Layer<RawStore, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      RawStore,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const rawDir = path.join(dataDir, "raw")
        const indexPath = path.join(rawDir, "index.json")
        const pagePath = (id: RecipeId) => path.join(rawDir, `${id}.html`)

        const io = <A>(target: string, effect: Effect.Effect<A, { readonly message: string }>) =>
          effect.pipe(Effect.mapError((error) => new StoreError({ path: target, message: error.message })))

        /** Write to `<target>.tmp` in the same directory, then rename over `target`. */
        const writeAtomic = (target: string, data: Uint8Array) => {
          const temp = `${target}${TEMP_SUFFIX}`
          return io(
            target,
            fs.makeDirectory(rawDir, { recursive: true }).pipe(
              Effect.andThen(fs.writeFile(temp, data)),
              Effect.andThen(fs.rename(temp, target)),
              Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore))
            )
          )
        }

        const readIndex = Effect.gen(function*() {
          const present = yield* io(indexPath, fs.exists(indexPath))
          if (!present) {
            return emptyRawIndex
          }
          const text = yield* io(indexPath, fs.readFileString(indexPath))
          return yield* Schema.decodeUnknownEffect(RawIndexJson)(text).pipe(
            Effect.mapError((error) =>
              new IndexInvalidError({
                path: indexPath,
                message: `${error.message}\nFix the file or move it away, then run again.`
              })
            )
          )
        })

        const load = Effect.gen(function*() {
          yield* io(rawDir, fs.makeDirectory(rawDir, { recursive: true }))
          const names = yield* io(rawDir, fs.readDirectory(rawDir))
          yield* Effect.forEach(
            names.filter((name) => name.endsWith(TEMP_SUFFIX)),
            (name) => io(rawDir, fs.remove(path.join(rawDir, name), { force: true })),
            { discard: true }
          )
          const index = yield* readIndex
          const pageIds = new Set<RecipeId>()
          for (const name of names) {
            const digits = PAGE_FILE.exec(name)?.[1]
            if (digits !== undefined) {
              const id = Schema.decodeUnknownOption(RecipeId)(Number(digits))
              if (Option.isSome(id)) {
                pageIds.add(id.value)
              }
            }
          }
          return { index, pageIds }
        })

        const savePage = (id: RecipeId, html: string) => writeAtomic(pagePath(id), new TextEncoder().encode(html))

        const saveIndex = (index: RawIndex) =>
          Schema.encodeEffect(RawIndexJson)(index).pipe(
            Effect.mapError((error) => new StoreError({ path: indexPath, message: error.message })),
            Effect.flatMap((text) => writeAtomic(indexPath, new TextEncoder().encode(`${text}\n`)))
          )

        return RawStore.of({ load, savePage, saveIndex })
      })
    )
}
