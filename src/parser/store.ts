import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ParseReportJson } from "../domain/parse-report.ts"
import type { ParseReport } from "../domain/parse-report.ts"
import { ParsedRecipeJson } from "../domain/parsed-recipe.ts"
import type { ParsedRecipe } from "../domain/parsed-recipe.ts"
import { RawIndexJson } from "../domain/raw-index.ts"
import type { RawIndex } from "../domain/raw-index.ts"
import type { RecipeId } from "../domain/recipe.ts"
import { IndexInvalidError, StoreError } from "../scraper/store.ts"

const TEMP_SUFFIX = ".tmp"

/**
 * `data/raw/` for reading and `data/parsed/` for writing.
 *
 * The store never changes `data/raw/`. The scraper can run at the same time.
 * Every write goes to a temporary file in the same directory first, then a rename puts it in place.
 */
export class ParseStore extends Context.Service<
  ParseStore,
  {
    /** Create `data/parsed/` and remove the temporary files of an interrupted write. */
    readonly prepare: Effect.Effect<void, StoreError>
    /** Read `data/raw/index.json`. */
    readonly readIndex: Effect.Effect<RawIndex, StoreError | IndexInvalidError>
    /** Read `data/raw/<id>.html` as UTF-8 text. */
    readonly readPage: (id: RecipeId) => Effect.Effect<string, StoreError>
    /** Write `data/parsed/<id>.json`. */
    readonly writeParsed: (recipe: ParsedRecipe) => Effect.Effect<void, StoreError>
    /** Remove `data/parsed/<id>.json`, for example the result of an older run. No error when the file does not exist. */
    readonly removeParsed: (id: RecipeId) => Effect.Effect<void, StoreError>
    /** Write `data/parsed/_report.json`. */
    readonly writeReport: (report: ParseReport) => Effect.Effect<void, StoreError>
  }
>()("say7/parser/ParseStore") {
  static readonly layer = (dataDir: string): Layer.Layer<ParseStore, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      ParseStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const rawDir = path.join(dataDir, "raw")
        const parsedDir = path.join(dataDir, "parsed")
        const indexPath = path.join(rawDir, "index.json")
        const pagePath = (id: RecipeId) => path.join(rawDir, `${id}.html`)
        const parsedPath = (id: RecipeId) => path.join(parsedDir, `${id}.json`)
        const reportPath = path.join(parsedDir, "_report.json")

        const io = <A>(target: string, effect: Effect.Effect<A, { readonly message: string }>) =>
          effect.pipe(Effect.mapError((error) => new StoreError({ path: target, message: error.message })))

        /** Write to `<target>.tmp` in the same directory, then rename over `target`. */
        const writeAtomic = (target: string, text: string) => {
          const temp = `${target}${TEMP_SUFFIX}`
          return io(
            target,
            fs.makeDirectory(parsedDir, { recursive: true }).pipe(
              Effect.andThen(fs.writeFileString(temp, text)),
              Effect.andThen(fs.rename(temp, target)),
              Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore))
            )
          )
        }

        const prepare = Effect.gen(function* () {
          yield* io(parsedDir, fs.makeDirectory(parsedDir, { recursive: true }))
          const names = yield* io(parsedDir, fs.readDirectory(parsedDir))
          yield* Effect.forEach(
            names.filter((name) => name.endsWith(TEMP_SUFFIX)),
            (name) => io(parsedDir, fs.remove(path.join(parsedDir, name), { force: true })),
            { discard: true }
          )
        })

        const readIndex = Effect.gen(function* () {
          const present = yield* io(indexPath, fs.exists(indexPath))
          if (!present) {
            return yield* new StoreError({
              path: indexPath,
              message: "The file does not exist. Run `npm run scrape` first.",
            })
          }
          const text = yield* io(indexPath, fs.readFileString(indexPath))
          return yield* Schema.decodeUnknownEffect(RawIndexJson)(text).pipe(
            Effect.mapError(
              (error) =>
                new IndexInvalidError({
                  path: indexPath,
                  message: error.message,
                })
            )
          )
        })

        const readPage = (id: RecipeId) => io(pagePath(id), fs.readFileString(pagePath(id)))

        const writeJson = <A, I>(target: string, codec: Schema.Codec<A, I>, value: A) =>
          Schema.encodeEffect(codec)(value).pipe(
            Effect.mapError((error) => new StoreError({ path: target, message: error.message })),
            Effect.flatMap((text) => writeAtomic(target, `${text}\n`))
          )

        return ParseStore.of({
          prepare,
          readIndex,
          readPage,
          writeParsed: (recipe) => writeJson(parsedPath(recipe.id), ParsedRecipeJson, recipe),
          removeParsed: (id) => io(parsedPath(id), fs.remove(parsedPath(id), { force: true })),
          writeReport: (report) => writeJson(reportPath, ParseReportJson, report),
        })
      })
    )
}
