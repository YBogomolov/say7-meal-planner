import { Effect, Option, Result, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { join } from "node:path"
import {
  configDirFlag,
  DEFAULT_CONFIG_DIR,
  DEFAULT_DATA_DIR,
  dataDirFlag,
  idsFlag,
  limitFlag,
  switchFlag,
} from "../cli/flags.ts"
import { UsageError } from "../cli/run.ts"
import { DEFAULT_MODEL, MODEL_NAMES } from "../domain/enriched-recipe.ts"
import type { ModelName } from "../domain/enriched-recipe.ts"
import type { RecipeId } from "../domain/recipe.ts"
import type { DryRunOptions, EnrichOptions } from "./run.ts"

/** The scope IDs come from `<config-dir>/household.json`, so the parser does not set `extraScopeIds`. */
export interface EnrichCliOptions extends Omit<EnrichOptions, "extraScopeIds"> {
  readonly dataDir: string
  readonly outDir: string
  readonly configDir: string
}

/** `--dry-run`: the same flags, but the model is optional. */
export interface DryRunCliOptions extends Omit<DryRunOptions, "extraScopeIds"> {
  readonly dataDir: string
  readonly outDir: string
  readonly configDir: string
}

export type EnrichCliCommand =
  | { readonly _tag: "Run"; readonly options: EnrichCliOptions }
  | { readonly _tag: "DryRun"; readonly options: DryRunCliOptions }

/** The flags, as the parser of effect/cli gives them. */
interface RawEnrichFlags {
  readonly model: Option.Option<ModelName>
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
  readonly limit: Option.Option<number>
  readonly sync: boolean
  readonly retryFailed: boolean
  readonly dryRun: boolean
  readonly dataDir: string
  readonly configDir: string
  readonly outDir: Option.Option<string>
}

/** Apply the rules that go across flags: the default model, the default `--out-dir`, and `--retry-failed`. */
export const enrichCommandOf = (raw: RawEnrichFlags): Result.Result<EnrichCliCommand, UsageError> => {
  if (raw.retryFailed && (Option.isSome(raw.ids) || Option.isSome(raw.limit))) {
    return Result.fail(
      new UsageError({
        message: "--retry-failed processes all failures of the last report. Do not use it with --ids or --limit.",
      })
    )
  }
  const common = {
    ids: raw.ids,
    limit: raw.limit,
    sync: raw.sync,
    retryFailed: raw.retryFailed,
    dataDir: raw.dataDir,
    configDir: raw.configDir,
    outDir: Option.getOrElse(raw.outDir, () => join(raw.dataDir, "enriched")),
  }
  return Result.succeed(
    raw.dryRun
      ? {
          _tag: "DryRun",
          options: {
            ...common,
            models: Option.match(raw.model, { onNone: () => MODEL_NAMES, onSome: (model) => [model] }),
          },
        }
      : { _tag: "Run", options: { ...common, model: Option.getOrElse(raw.model, () => DEFAULT_MODEL) } }
  )
}

/** `npm run enrich`. The handler gets a run or a dry run. */
export const makeEnrichCommand = <E, R>(handler: (command: EnrichCliCommand) => Effect.Effect<void, E, R>) =>
  Command.make(
    "enrich",
    {
      model: Flag.Literals("model", MODEL_NAMES).pipe(
        Flag.optional,
        Flag.withDescription(
          `One of: ${MODEL_NAMES.join(", ")}. Default: ${DEFAULT_MODEL}. Without --model, --dry-run estimates every model.`
        )
      ),
      ids: idsFlag("Process only these recipe IDs (id,id,...)."),
      limit: limitFlag("Process the first n recipes that need a call."),
      sync: switchFlag(
        "sync",
        "Use one request for each recipe. Without this flag, a run of more than 20 recipes uses a batch."
      ),
      retryFailed: switchFlag(
        "retry-failed",
        "Process the failures of <out-dir>/_report.json in sync mode. Do not use it with --ids or --limit."
      ),
      dataDir: dataDirFlag(`Directory of the downloaded data (default ${DEFAULT_DATA_DIR}).`),
      configDir: configDirFlag(
        `Directory of the settings (default ${DEFAULT_CONFIG_DIR}). household.json adds recipes to the scope.`
      ),
      outDir: Flag.String("out-dir").pipe(
        Flag.withSchema(Schema.NonEmptyString),
        Flag.optional,
        Flag.withDescription("Directory for the results (default <data-dir>/enriched).")
      ),
      dryRun: switchFlag(
        "dry-run",
        "Build and check the requests of all recipes in scope. Print the sizes and the estimated cost of each model (or of the model of --model). Send no request, need no key, write no file."
      ),
    },
    (raw) => Effect.fromResult(enrichCommandOf(raw)).pipe(Effect.flatMap(handler))
  ).pipe(
    Command.withDescription(
      [
        "Enrich the parsed recipes in <data-dir>/parsed/ with the Anthropic API.",
        "Each recipe in scope gives one file <id>.json in <out-dir>. The file _report.json has the totals, the failures and the cost.",
        "The key is in the variable ANTHROPIC_API_KEY, or in the file .env.",
      ].join("\n  ")
    )
  )
