import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { Command } from "effect/cli"
import { DEFAULT_DATA_DIR, dataDirFlag } from "../cli/flags.ts"
import { RecipeId } from "../domain/recipe.ts"

export class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** `test/fixtures/real-ids.json`: a JSON array of recipe IDs without duplicates. */
export const FixtureIdsJson = Schema.fromJsonString(
  Schema.UniqueArray(RecipeId).pipe(Schema.check(Schema.isNonEmpty()))
)

export interface FixturesCliOptions {
  readonly dataDir: string
}

/** `npm run fixtures:refresh`. The handler gets the parsed options. */
export const makeFixturesCommand = <E, R>(handler: (options: FixturesCliOptions) => Effect.Effect<void, E, R>) =>
  Command.make(
    "fixtures:refresh",
    { dataDir: dataDirFlag(`Directory of the downloaded data (default ${DEFAULT_DATA_DIR}).`) },
    handler
  ).pipe(
    Command.withDescription(
      [
        "Copy the pages listed in test/fixtures/real-ids.json from <data-dir>/raw/ to test/fixtures/real/.",
        "The golden tests of the parser read these files. The directory test/fixtures/real/ is git-ignored.",
      ].join("\n  ")
    )
  )

export interface RefreshOptions {
  /** `test/fixtures/real-ids.json` */
  readonly idsFile: string
  /** `<data-dir>/raw` */
  readonly sourceDir: string
  /** `test/fixtures/real` */
  readonly targetDir: string
}

export interface RefreshSummary {
  readonly copied: ReadonlyArray<RecipeId>
  /** IDs whose page is not in the source directory. */
  readonly missing: ReadonlyArray<RecipeId>
}

/** Copy `<id>.html` for each ID in the list from the source directory to the target directory. */
export const refreshFixtures = (
  options: RefreshOptions
): Effect.Effect<RefreshSummary, FixtureError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const io = <A>(target: string, effect: Effect.Effect<A, { readonly message: string }>) =>
      effect.pipe(Effect.mapError((error) => new FixtureError({ path: target, message: error.message })))

    const text = yield* io(options.idsFile, fs.readFileString(options.idsFile))
    const ids = yield* Schema.decodeUnknownEffect(FixtureIdsJson)(text).pipe(
      Effect.mapError((error) => new FixtureError({ path: options.idsFile, message: error.message }))
    )
    yield* io(options.targetDir, fs.makeDirectory(options.targetDir, { recursive: true }))

    const copyOne = (id: RecipeId) =>
      Effect.gen(function* () {
        const source = path.join(options.sourceDir, `${id}.html`)
        const target = path.join(options.targetDir, `${id}.html`)
        const temp = `${target}.tmp`
        if (!(yield* io(source, fs.exists(source)))) {
          yield* Console.warn(`missing: ${source}`)
          return Option.none<RecipeId>()
        }
        yield* io(
          target,
          fs.copyFile(source, temp).pipe(
            Effect.andThen(fs.rename(temp, target)),
            Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore))
          )
        )
        yield* Console.log(`copied: ${id}.html`)
        return Option.some(id)
      })

    const results = yield* Effect.forEach(ids, (id) => copyOne(id).pipe(Effect.map((copied) => ({ id, copied }))))
    return {
      copied: results.flatMap((result) => (Option.isSome(result.copied) ? [result.id] : [])),
      missing: results.flatMap((result) => (Option.isNone(result.copied) ? [result.id] : [])),
    }
  })
