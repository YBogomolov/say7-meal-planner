import { Effect, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_DATA_DIR, dataDirFlag } from "../cli/flags.ts"

/** `test/fixtures/gold.json` of this project, whatever the working directory is. */
export const DEFAULT_GOLD_FILE = fileURLToPath(new URL("../../test/fixtures/gold.json", import.meta.url))

export interface EvalCliOptions {
  readonly dataDir: string
  readonly outDir: string
  readonly goldFile: string
}

/** `npm run enrich:eval`. The handler gets the parsed options. */
export const makeEvalCommand = <E, R>(handler: (options: EvalCliOptions) => Effect.Effect<void, E, R>) =>
  Command.make(
    "enrich:eval",
    {
      outDir: Flag.String("out-dir").pipe(
        Flag.withSchema(Schema.NonEmptyString),
        Flag.optional,
        Flag.withDescription("Directory of the enrichments (default <data-dir>/enriched).")
      ),
      dataDir: dataDirFlag(`Directory of the downloaded data, for <data-dir>/parsed (default ${DEFAULT_DATA_DIR}).`),
      gold: Flag.String("gold").pipe(
        Flag.withSchema(Schema.NonEmptyString),
        Flag.withDefault(DEFAULT_GOLD_FILE),
        Flag.withDescription("The gold file (default test/fixtures/gold.json).")
      ),
    },
    ({ outDir, dataDir, gold }) =>
      handler({
        dataDir,
        outDir: Option.getOrElse(outDir, () => join(dataDir, "enriched")),
        goldFile: gold,
      })
  ).pipe(
    Command.withDescription(
      [
        "Compare the enrichments in <out-dir> for the recipes of the gold file with the expected facts.",
        "Print the score of each field and the total. Write <out-dir>/_eval.json.",
      ].join("\n")
    )
  )
