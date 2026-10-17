import { Option, Result, Schema } from "effect"
import { parseArgs } from "node:util"
import type { RecipeId } from "../domain/recipe.ts"
import { CliError, DEFAULT_DATA_DIR, RecipeIdsFromString } from "../scraper/cli-options.ts"

export const USAGE = `Usage: npm run parse -- [options]

Parse the recipe pages in <data-dir>/raw/ into <data-dir>/parsed/.
Each page with status "ok" in <data-dir>/raw/index.json gives one file <id>.json.
The file _report.json has the totals, the failed pages and the warnings.

Options:
  --ids <id,id,...>  Parse only these recipe IDs.
  --data-dir <path>  Directory of the downloaded data (default ${DEFAULT_DATA_DIR}).
  -h, --help         Show this text.`

export interface ParseCliOptions {
  /** Parse only these IDs. `None` means every page with status `ok`. */
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
  readonly dataDir: string
}

export type ParseCliCommand = { readonly _tag: "Help" } | { readonly _tag: "Run"; readonly options: ParseCliOptions }

const CliArgs = Schema.Struct({
  ids: Schema.optional(RecipeIdsFromString),
  help: Schema.optional(Schema.Boolean),
  "data-dir": Schema.optional(Schema.NonEmptyString),
})

/** Parse the command line (`process.argv.slice(2)`). */
export const parseParseCli = (argv: ReadonlyArray<string>): Result.Result<ParseCliCommand, CliError> =>
  Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        options: {
          ids: { type: "string" },
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
      Schema.decodeUnknownResult(CliArgs)(values).pipe(
        Result.mapError((error) => new CliError({ message: `Invalid option.\n${error.message}` }))
      )
    ),
    Result.map((args): ParseCliCommand =>
      args.help === true
        ? { _tag: "Help" }
        : {
            _tag: "Run",
            options: {
              ids: Option.fromUndefinedOr(args.ids).pipe(Option.map((ids) => new Set(ids))),
              dataDir: args["data-dir"] ?? DEFAULT_DATA_DIR,
            },
          }
    )
  )
