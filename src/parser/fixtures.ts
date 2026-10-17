import { Console, Effect, FileSystem, Option, Path, Result, Schema } from "effect"
import { parseArgs } from "node:util"
import { RecipeId } from "../domain/recipe.ts"
import { CliError, DEFAULT_DATA_DIR } from "../scraper/cli-options.ts"

export const FIXTURES_USAGE = `Usage: npm run fixtures:refresh -- [options]

Copy the pages listed in test/fixtures/real-ids.json from <data-dir>/raw/ to test/fixtures/real/.
The golden tests of the parser read these files. The directory test/fixtures/real/ is git-ignored.

Options:
  --data-dir <path>  Directory of the downloaded data (default ${DEFAULT_DATA_DIR}).
  -h, --help         Show this text.`

export class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** `test/fixtures/real-ids.json`: a JSON array of recipe IDs without duplicates. */
export const FixtureIdsJson = Schema.fromJsonString(
  Schema.UniqueArray(RecipeId).pipe(Schema.check(Schema.isNonEmpty()))
)

export type FixturesCommand = { readonly _tag: "Help" } | { readonly _tag: "Run"; readonly dataDir: string }

const FixturesArgs = Schema.Struct({
  help: Schema.optional(Schema.Boolean),
  "data-dir": Schema.optional(Schema.NonEmptyString),
})

/** Parse the command line (`process.argv.slice(2)`). */
export const parseFixturesCli = (argv: ReadonlyArray<string>): Result.Result<FixturesCommand, CliError> =>
  Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        options: {
          "data-dir": { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
        strict: true,
      }).values,
    catch: (cause) =>
      new CliError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Result.flatMap((values) =>
      Schema.decodeUnknownResult(FixturesArgs)(values).pipe(
        Result.mapError((error) => new CliError({ message: `Invalid option.\n${error.message}` }))
      )
    ),
    Result.map((args): FixturesCommand =>
      args.help === true ? { _tag: "Help" } : { _tag: "Run", dataDir: args["data-dir"] ?? DEFAULT_DATA_DIR }
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
