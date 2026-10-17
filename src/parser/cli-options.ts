import { Effect, Option } from "effect"
import { Command } from "effect/cli"
import { DEFAULT_DATA_DIR, dataDirFlag, idsFlag } from "../cli/flags.ts"
import type { RecipeId } from "../domain/recipe.ts"

export interface ParseCliOptions {
  /** Parse only these IDs. `None` means every page with status `ok`. */
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
  readonly dataDir: string
}

/** `npm run parse`. The handler gets the parsed options. */
export const makeParseCommand = <E, R>(handler: (options: ParseCliOptions) => Effect.Effect<void, E, R>) =>
  Command.make(
    "parse",
    {
      ids: idsFlag("Parse only these recipe IDs (id,id,...)."),
      dataDir: dataDirFlag(`Directory of the downloaded data (default ${DEFAULT_DATA_DIR}).`),
    },
    handler
  ).pipe(
    Command.withDescription(
      [
        "Parse the recipe pages in <data-dir>/raw/ into <data-dir>/parsed/.",
        'Each page with status "ok" in <data-dir>/raw/index.json gives one file <id>.json.',
        "The file _report.json has the totals, the failed pages and the warnings.",
      ].join("\n  ")
    )
  )
