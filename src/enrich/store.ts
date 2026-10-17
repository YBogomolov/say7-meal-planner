import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { BatchStateJson, EnrichReportJson } from "../domain/enrich-report.ts"
import type { BatchState, EnrichReport } from "../domain/enrich-report.ts"
import { EvalReportJson } from "../domain/enrich-eval.ts"
import type { EvalReport } from "../domain/enrich-eval.ts"
import { EnrichedRecipeJson } from "../domain/enriched-recipe.ts"
import type { EnrichedRecipe } from "../domain/enriched-recipe.ts"
import { ParsedRecipeJson } from "../domain/parsed-recipe.ts"
import type { ParsedRecipe } from "../domain/parsed-recipe.ts"
import { RecipeId } from "../domain/recipe.ts"
import { StoreError } from "../scraper/store.ts"

const TEMP_SUFFIX = ".tmp"
const RECIPE_FILE = /^([1-9]\d*)\.json$/

/** The parsed file of a recipe cannot be read, or it is not a valid `ParsedRecipe`. */
export class ParsedReadError extends Schema.TaggedError<ParsedReadError>()("ParsedReadError", {
  id: RecipeId,
  message: Schema.String,
}) {}

/** A control file of the output directory (`_report.json`, `_batch.json`) exists but is not valid. */
export class ControlFileInvalidError extends Schema.TaggedError<ControlFileInvalidError>()("ControlFileInvalidError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * `<data-dir>/parsed/` for reading and `<out-dir>/` for writing.
 *
 * The output directory has `<id>.json` for each recipe, `_report.json`, `_batch.json` and `_eval.json`.
 * Every write goes to a temporary file in the same directory first, then a rename puts it in place.
 */
export class EnrichStore extends Context.Service<
  EnrichStore,
  {
    /** Create the output directory and remove the temporary files of an interrupted write. */
    readonly prepare: Effect.Effect<void, StoreError>
    /** The IDs of the files `<data-dir>/parsed/<id>.json`. */
    readonly listParsedIds: Effect.Effect<ReadonlyArray<RecipeId>, StoreError>
    readonly readParsed: (id: RecipeId) => Effect.Effect<ParsedRecipe, ParsedReadError>
    /** `None` if the file is absent or not valid. A stored file that is not valid counts as absent and is replaced. */
    readonly readEnriched: (id: RecipeId) => Effect.Effect<Option.Option<EnrichedRecipe>, StoreError>
    readonly writeEnriched: (recipe: EnrichedRecipe) => Effect.Effect<void, StoreError>
    readonly readReport: Effect.Effect<Option.Option<EnrichReport>, StoreError | ControlFileInvalidError>
    readonly writeReport: (report: EnrichReport) => Effect.Effect<void, StoreError>
    readonly readBatch: Effect.Effect<Option.Option<BatchState>, StoreError | ControlFileInvalidError>
    readonly writeBatch: (state: BatchState) => Effect.Effect<void, StoreError>
    /** No error if the file does not exist. */
    readonly removeBatch: Effect.Effect<void, StoreError>
    readonly writeEval: (report: EvalReport) => Effect.Effect<void, StoreError>
  }
>()("say7/enrich/EnrichStore") {
  static readonly layer = (config: {
    readonly dataDir: string
    readonly outDir: string
  }): Layer.Layer<EnrichStore, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      EnrichStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const parsedDir = path.join(config.dataDir, "parsed")
        const { outDir } = config
        const parsedPath = (id: RecipeId) => path.join(parsedDir, `${id}.json`)
        const enrichedPath = (id: RecipeId) => path.join(outDir, `${id}.json`)
        const reportPath = path.join(outDir, "_report.json")
        const batchPath = path.join(outDir, "_batch.json")
        const evalPath = path.join(outDir, "_eval.json")

        const io = <A>(target: string, effect: Effect.Effect<A, { readonly message: string }>) =>
          effect.pipe(Effect.mapError((error) => new StoreError({ path: target, message: error.message })))

        /** Write to `<target>.tmp` in the same directory, then rename over `target`. */
        const writeAtomic = (target: string, text: string) => {
          const temp = `${target}${TEMP_SUFFIX}`
          return io(
            target,
            fs.makeDirectory(outDir, { recursive: true }).pipe(
              Effect.andThen(fs.writeFileString(temp, text)),
              Effect.andThen(fs.rename(temp, target)),
              Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore))
            )
          )
        }

        const writeJson = <A, I>(target: string, codec: Schema.Codec<A, I>, value: A) =>
          Schema.encodeEffect(codec)(value).pipe(
            Effect.mapError((error) => new StoreError({ path: target, message: error.message })),
            Effect.flatMap((text) => writeAtomic(target, `${text}\n`))
          )

        /** Read and decode a control file. `None` if it does not exist. */
        const readControl = <A, I>(target: string, codec: Schema.Codec<A, I>, hint: string) =>
          Effect.gen(function* () {
            const present = yield* io(target, fs.exists(target))
            if (!present) {
              return Option.none<A>()
            }
            const text = yield* io(target, fs.readFileString(target))
            return Option.some(
              yield* Schema.decodeUnknownEffect(codec)(text).pipe(
                Effect.mapError(
                  (error) =>
                    new ControlFileInvalidError({
                      path: target,
                      message: `${error.message}\n${hint}`,
                    })
                )
              )
            )
          })

        const prepare = Effect.gen(function* () {
          yield* io(outDir, fs.makeDirectory(outDir, { recursive: true }))
          const names = yield* io(outDir, fs.readDirectory(outDir))
          yield* Effect.forEach(
            names.filter((name) => name.endsWith(TEMP_SUFFIX)),
            (name) => io(outDir, fs.remove(path.join(outDir, name), { force: true })),
            { discard: true }
          )
        })

        const listParsedIds = Effect.gen(function* () {
          if (!(yield* io(parsedDir, fs.exists(parsedDir)))) {
            return yield* new StoreError({
              path: parsedDir,
              message: "The directory does not exist. Run `npm run parse` first.",
            })
          }
          const names = yield* io(parsedDir, fs.readDirectory(parsedDir))
          return names.flatMap((name) => {
            const digits = RECIPE_FILE.exec(name)?.[1]
            return digits === undefined ? [] : Option.toArray(Schema.decodeUnknownOption(RecipeId)(Number(digits)))
          })
        })

        const readParsed = (id: RecipeId) =>
          fs.readFileString(parsedPath(id)).pipe(
            Effect.flatMap((text) => Schema.decodeUnknownEffect(ParsedRecipeJson)(text)),
            Effect.mapError((error) => new ParsedReadError({ id, message: error.message }))
          )

        const readEnriched = (id: RecipeId) =>
          Effect.gen(function* () {
            const target = enrichedPath(id)
            if (!(yield* io(target, fs.exists(target)))) {
              return Option.none<EnrichedRecipe>()
            }
            const text = yield* io(target, fs.readFileString(target))
            return Option.getSuccess(yield* Effect.result(Schema.decodeUnknownEffect(EnrichedRecipeJson)(text)))
          })

        return EnrichStore.of({
          prepare,
          listParsedIds,
          readParsed,
          readEnriched,
          writeEnriched: (recipe) => writeJson(enrichedPath(recipe.id), EnrichedRecipeJson, recipe),
          readReport: readControl(reportPath, EnrichReportJson, "Fix the file or move it away, then run again."),
          writeReport: (report) => writeJson(reportPath, EnrichReportJson, report),
          readBatch: readControl(
            batchPath,
            BatchStateJson,
            "Fix the file or move it away. The batch can still run at the API: look for it in the console of Anthropic."
          ),
          writeBatch: (state) => writeJson(batchPath, BatchStateJson, state),
          removeBatch: io(batchPath, fs.remove(batchPath, { force: true })),
          writeEval: (report) => writeJson(evalPath, EvalReportJson, report),
        })
      })
    )
}
