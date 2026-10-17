import { Flag } from "effect/cli"
import { Option, Schema, SchemaTransformation } from "effect"
import { RecipeId } from "../domain/recipe.ts"

export const DEFAULT_DATA_DIR = "data"
export const DEFAULT_CONFIG_DIR = "config"

const DigitsString = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d+$/, {
      message: "Expected a non-negative whole number",
    })
  )
)

/** `"0"`, `"2500"`. */
export const NaturalFromString = DigitsString.pipe(
  Schema.decodeTo(Schema.FiniteFromString),
  Schema.decodeTo(Schema.Natural)
)

/** `"1"`, `"20"`. `"0"` is an error. */
export const PositiveIntFromString = NaturalFromString.pipe(Schema.check(Schema.isGreaterThan(0)))

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

/** A directory flag with a default. The empty text is an error. */
const directoryFlag = (name: string, fallback: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withSchema(Schema.NonEmptyString),
    Flag.withDefault(fallback),
    Flag.withDescription(description)
  )

/** `--data-dir <path>`, default `data`. */
export const dataDirFlag = (description: string) => directoryFlag("data-dir", DEFAULT_DATA_DIR, description)

/** `--config-dir <path>`, default `config`. */
export const configDirFlag = (description: string) => directoryFlag("config-dir", DEFAULT_CONFIG_DIR, description)

/** `--ids <id,id,...>`: `None` when the flag is missing. */
export const idsFlag = (description: string) =>
  Flag.String("ids").pipe(
    Flag.withSchema(RecipeIdsFromString),
    Flag.map((ids): ReadonlySet<RecipeId> => new Set(ids)),
    Flag.optional,
    Flag.withDescription(description)
  )

/** `--limit <n>`: `None` when the flag is missing. */
export const limitFlag = (description: string): Flag.Flag<Option.Option<number>> =>
  Flag.String("limit").pipe(Flag.withSchema(PositiveIntFromString), Flag.optional, Flag.withDescription(description))

/** A switch such as `--force`: `false` when the flag is missing. */
export const switchFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.withDescription(description))
