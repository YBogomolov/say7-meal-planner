import { Option, Result, Schema, SchemaTransformation } from "effect"
import { parseArgs } from "node:util"
import { RecipeId } from "../domain/recipe.ts"

export const DEFAULT_BASE_URL = "https://www.say7.info"
export const DEFAULT_DELAY_MS = 2500
export const DEFAULT_DATA_DIR = "data"

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  message: Schema.String,
}) {}

export const USAGE = `Usage: npm run scrape -- [options]

Download recipe pages from say7.info into <data-dir>/raw/.

Options:
  --limit <n>        Process the first n recipes that need a fetch.
  --ids <id,id,...>  Process only these recipe IDs.
  --force            Fetch again, also if the cache is current.
  --delay-ms <n>     Base delay between requests in ms (default ${DEFAULT_DELAY_MS}).
  --base-url <url>   Origin of the site (default ${DEFAULT_BASE_URL}).
  --data-dir <path>  Directory for downloaded data (default ${DEFAULT_DATA_DIR}).
  -h, --help         Show this text.`

export interface CliOptions {
  readonly limit: Option.Option<number>
  readonly ids: Option.Option<ReadonlySet<RecipeId>>
  readonly force: boolean
  readonly delayMs: number
  /** Origin without a trailing slash. */
  readonly baseUrl: string
  readonly dataDir: string
}

export type CliCommand = { readonly _tag: "Help" } | { readonly _tag: "Run"; readonly options: CliOptions }

const DigitsString = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d+$/, {
      message: "Expected a non-negative whole number",
    })
  )
)

const NaturalFromString = DigitsString.pipe(Schema.decodeTo(Schema.FiniteFromString), Schema.decodeTo(Schema.Natural))

const PositiveIntFromString = NaturalFromString.pipe(Schema.check(Schema.isGreaterThan(0)))

const RecipeIdFromString = DigitsString.pipe(Schema.decodeTo(Schema.FiniteFromString), Schema.decodeTo(RecipeId))

/** `"12,34"` becomes the IDs 12 and 34. */
export const RecipeIdsFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(RecipeIdFromString).pipe(Schema.check(Schema.isNonEmpty())),
    SchemaTransformation.transform<ReadonlyArray<string>, string>({
      decode: (text) => text.split(",").map((part) => part.trim()),
      encode: (ids) => ids.join(","),
    })
  )
)

/** Origin of an `http` or `https` site, without a trailing slash. A path, query or fragment is an error. */
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

const CliArgs = Schema.Struct({
  limit: Schema.optional(PositiveIntFromString),
  ids: Schema.optional(RecipeIdsFromString),
  force: Schema.optional(Schema.Boolean),
  help: Schema.optional(Schema.Boolean),
  "delay-ms": Schema.optional(NaturalFromString),
  "base-url": Schema.optional(OriginFromString),
  "data-dir": Schema.optional(Schema.NonEmptyString),
})

/** Parse the command line (`process.argv.slice(2)`). */
export const parseCli = (argv: ReadonlyArray<string>): Result.Result<CliCommand, CliError> =>
  Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        options: {
          limit: { type: "string" },
          ids: { type: "string" },
          force: { type: "boolean" },
          "delay-ms": { type: "string" },
          "base-url": { type: "string" },
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
    Result.map((args): CliCommand =>
      args.help === true
        ? { _tag: "Help" }
        : {
            _tag: "Run",
            options: {
              limit: Option.fromUndefinedOr(args.limit),
              ids: Option.fromUndefinedOr(args.ids).pipe(Option.map((ids) => new Set(ids))),
              force: args.force === true,
              delayMs: args["delay-ms"] ?? DEFAULT_DELAY_MS,
              baseUrl: args["base-url"] ?? DEFAULT_BASE_URL,
              dataDir: args["data-dir"] ?? DEFAULT_DATA_DIR,
            },
          }
    )
  )
