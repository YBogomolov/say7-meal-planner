import { Effect, Option, Schema, SchemaTransformation } from "effect"
import { Command, Flag } from "effect/cli"
import { DEFAULT_DATA_DIR, dataDirFlag, idsFlag, limitFlag, NaturalFromString, switchFlag } from "../cli/flags.ts"
import type { RecipeId } from "../domain/recipe.ts"

export { DEFAULT_DATA_DIR }
export const DEFAULT_BASE_URL = "https://www.say7.info"
export const DEFAULT_DELAY_MS = 2500

export interface CliOptions {
  readonly limit: Option.Option<number>
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
  readonly force: boolean
  readonly delayMs: number
  /** Origin without a trailing slash. */
  readonly baseUrl: string
  readonly dataDir: string
}

export const originOf = (text: string): Option.Option<string> => {
  if (!URL.canParse(text)) {
    return Option.none()
  }
  const url = new URL(text)
  const plain =
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    !text.includes("?") &&
    !text.includes("#") &&
    url.username === "" &&
    url.password === ""
  return (url.protocol === "https:" || url.protocol === "http:") && plain ? Option.some(url.origin) : Option.none()
}

const OriginFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (text: string) => Option.getOrElse(originOf(text), () => text),
      encode: (origin: string) => origin,
    })
  ),
  Schema.check(
    Schema.makeFilter(
      (text: string) => Option.isSome(originOf(text)) || "Expected an http(s) origin such as https://www.say7.info"
    )
  )
)

/**
 * `npm run scrape`. The handler gets the parsed options.
 * Tests pass a handler that records the options.
 */
export const makeScrapeCommand = <E, R>(handler: (options: CliOptions) => Effect.Effect<void, E, R>) =>
  Command.make(
    "scrape",
    {
      limit: limitFlag("Process the first n recipes that need a fetch."),
      ids: idsFlag("Process only these recipe IDs (id,id,...)."),
      force: switchFlag("force", "Fetch again, also if the cache is current."),
      delayMs: Flag.String("delay-ms").pipe(
        Flag.withSchema(NaturalFromString),
        Flag.withDefault(DEFAULT_DELAY_MS),
        Flag.withDescription(`Base delay between requests in ms (default ${DEFAULT_DELAY_MS}).`)
      ),
      baseUrl: Flag.String("base-url").pipe(
        Flag.withSchema(OriginFromString),
        Flag.withDefault(DEFAULT_BASE_URL),
        Flag.withDescription(`Origin of the site (default ${DEFAULT_BASE_URL}).`)
      ),
      dataDir: dataDirFlag(`Directory for downloaded data (default ${DEFAULT_DATA_DIR}).`),
    },
    handler
  ).pipe(Command.withDescription("Download recipe pages from say7.info into <data-dir>/raw/."))
