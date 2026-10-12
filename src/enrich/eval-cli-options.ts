import { Result, Schema } from "effect"
import { parseArgs } from "node:util"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CliError, DEFAULT_DATA_DIR } from "../scraper/cli-options.ts"

/** `test/fixtures/gold.json` of this project, whatever the working directory is. */
export const DEFAULT_GOLD_FILE = fileURLToPath(new URL("../../test/fixtures/gold.json", import.meta.url))

export const EVAL_USAGE = `Usage: npm run enrich:eval -- [options]

Compare the enrichments in <out-dir> for the recipes of the gold file with the expected facts.
Print the score of each field and the total. Write <out-dir>/_eval.json.

Options:
  --out-dir <path>   Directory of the enrichments (default <data-dir>/enriched).
  --data-dir <path>  Directory of the downloaded data, for <data-dir>/parsed (default ${DEFAULT_DATA_DIR}).
  --gold <path>      The gold file (default test/fixtures/gold.json).
  -h, --help         Show this text.`

export type EvalCliCommand =
  | { readonly _tag: "Help" }
  | {
    readonly _tag: "Run"
    readonly options: { readonly dataDir: string; readonly outDir: string; readonly goldFile: string }
  }

const EvalArgs = Schema.Struct({
  help: Schema.optional(Schema.Boolean),
  "data-dir": Schema.optional(Schema.NonEmptyString),
  "out-dir": Schema.optional(Schema.NonEmptyString),
  gold: Schema.optional(Schema.NonEmptyString)
})

export const parseEvalCli = (argv: ReadonlyArray<string>): Result.Result<EvalCliCommand, CliError> =>
  Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        options: {
          "data-dir": { type: "string" },
          "out-dir": { type: "string" },
          gold: { type: "string" },
          help: { type: "boolean", short: "h" }
        },
        allowPositionals: false,
        strict: true
      }).values,
    catch: (cause) => new CliError({ message: cause instanceof Error ? cause.message : String(cause) })
  }).pipe(
    Result.flatMap((values) =>
      Schema.decodeUnknownResult(EvalArgs)(values).pipe(
        Result.mapError((error) => new CliError({ message: `Invalid option.\n${error.message}` }))
      )
    ),
    Result.map((args): EvalCliCommand => {
      if (args.help === true) {
        return { _tag: "Help" }
      }
      const dataDir = args["data-dir"] ?? DEFAULT_DATA_DIR
      return {
        _tag: "Run",
        options: {
          dataDir,
          outDir: args["out-dir"] ?? join(dataDir, "enriched"),
          goldFile: args.gold ?? DEFAULT_GOLD_FILE
        }
      }
    })
  )
