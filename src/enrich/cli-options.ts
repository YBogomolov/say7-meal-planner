import { Option, Result, Schema } from "effect"
import { parseArgs } from "node:util"
import { join } from "node:path"
import { DEFAULT_MODEL, MODEL_NAMES, ModelName } from "../domain/enriched-recipe.ts"
import type { RecipeId } from "../domain/recipe.ts"
import { CliError, DEFAULT_DATA_DIR, RecipeIdsFromString } from "../scraper/cli-options.ts"
import type { DryRunOptions, EnrichOptions } from "./run.ts"

export const USAGE = `Usage: npm run enrich -- [--model <name>] [options]
       npm run enrich -- --dry-run [options]

Enrich the parsed recipes in <data-dir>/parsed/ with the Anthropic API.
Each recipe in scope gives one file <id>.json in <out-dir>. The file _report.json has the totals, the failures and the cost.
The key is in the variable ANTHROPIC_API_KEY, or in the file .env.

Options:
  --model <name>     One of: ${MODEL_NAMES.join(", ")}. Default: ${DEFAULT_MODEL}. Without --model, --dry-run estimates every model.
  --ids <id,id,...>  Process only these recipe IDs.
  --limit <n>        Process the first n recipes that need a call.
  --sync             Use one request for each recipe. Without this flag, a run of more than 20 recipes uses a batch.
  --retry-failed     Process the failures of <out-dir>/_report.json in sync mode.
                     Do not use it with --ids or --limit.
  --data-dir <path>  Directory of the downloaded data (default ${DEFAULT_DATA_DIR}).
  --out-dir <path>   Directory for the results (default <data-dir>/enriched).
  --dry-run          Build and check the requests of all recipes in scope. Print the sizes and the estimated cost
                     of each model (or of the model of --model). Send no request, need no key, write no file.
  -h, --help         Show this text.`

export interface EnrichCliOptions extends EnrichOptions {
  readonly dataDir: string
  readonly outDir: string
}

/** `--dry-run`: the same flags, but the model is optional. */
export interface DryRunCliOptions extends DryRunOptions {
  readonly dataDir: string
  readonly outDir: string
}

export type EnrichCliCommand =
  | { readonly _tag: "Help" }
  | { readonly _tag: "Run"; readonly options: EnrichCliOptions }
  | { readonly _tag: "DryRun"; readonly options: DryRunCliOptions }

const PositiveIntFromString = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[1-9]\d*$/, {
      message: "Expected a whole number above 0",
    })
  ),
  Schema.decodeTo(Schema.FiniteFromString),
  Schema.decodeTo(Schema.Int)
)

const CliArgs = Schema.Struct({
  model: Schema.optional(ModelName),
  ids: Schema.optional(RecipeIdsFromString),
  limit: Schema.optional(PositiveIntFromString),
  sync: Schema.optional(Schema.Boolean),
  "retry-failed": Schema.optional(Schema.Boolean),
  "dry-run": Schema.optional(Schema.Boolean),
  help: Schema.optional(Schema.Boolean),
  "data-dir": Schema.optional(Schema.NonEmptyString),
  "out-dir": Schema.optional(Schema.NonEmptyString),
})

const usageError = (message: string) => Result.fail(new CliError({ message }))

/** Parse the command line (`process.argv.slice(2)`). */
export const parseEnrichCli = (argv: ReadonlyArray<string>): Result.Result<EnrichCliCommand, CliError> =>
  Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        options: {
          model: { type: "string" },
          ids: { type: "string" },
          limit: { type: "string" },
          sync: { type: "boolean" },
          "retry-failed": { type: "boolean" },
          "dry-run": { type: "boolean" },
          "data-dir": { type: "string" },
          "out-dir": { type: "string" },
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
    Result.flatMap((args): Result.Result<EnrichCliCommand, CliError> => {
      if (args.help === true) {
        return Result.succeed({ _tag: "Help" })
      }
      const retryFailed = args["retry-failed"] === true
      if (retryFailed && (args.ids !== undefined || args.limit !== undefined)) {
        return usageError(
          "--retry-failed processes all failures of the last report. Do not use it with --ids or --limit."
        )
      }
      const dataDir = args["data-dir"] ?? DEFAULT_DATA_DIR
      const common = {
        ids: Option.fromUndefinedOr(args.ids).pipe(Option.map((ids): ReadonlySet<RecipeId> => new Set(ids))),
        limit: Option.fromUndefinedOr(args.limit),
        sync: args.sync === true,
        retryFailed,
        dataDir,
        outDir: args["out-dir"] ?? join(dataDir, "enriched"),
      }
      if (args["dry-run"] === true) {
        return Result.succeed({
          _tag: "DryRun",
          options: {
            ...common,
            models: args.model === undefined ? MODEL_NAMES : [args.model],
          },
        })
      }
      return Result.succeed({
        _tag: "Run",
        options: { ...common, model: args.model ?? DEFAULT_MODEL },
      })
    })
  )
