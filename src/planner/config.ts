import { Effect, FileSystem, Path, Schema } from "effect"
import type { Aliases } from "../domain/catalogue.ts"
import { DECODE_OPTIONS, DEFAULT_HOUSEHOLD, HouseholdJson } from "../domain/household.ts"
import type { Household } from "../domain/household.ts"
import { AliasesJson, makeAliases } from "./items.ts"

export const DEFAULT_CONFIG_DIR = "config"
export const DEFAULT_DATA_DIR = "data"

/** A file of `config/` exists but cannot be read, or it is not valid. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.String,
  message: Schema.String
}) {}

/** The text of a config file, or `undefined` if the file does not exist. */
const readOptional = (target: string): Effect.Effect<string | undefined, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(target))) {
      return undefined
    }
    return yield* fs.readFileString(target)
  }).pipe(
    Effect.mapError((error) => new ConfigError({ path: target, message: `Файл ${target} не читается: ${error.message}` }))
  )

/** `<configDir>/household.json` (spec P4.1). A missing file gives the defaults of the spec. */
export const loadHousehold = (
  configDir: string = DEFAULT_CONFIG_DIR
): Effect.Effect<Household, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const target = path.join(configDir, "household.json")
    const text = yield* readOptional(target)
    if (text === undefined) {
      return DEFAULT_HOUSEHOLD
    }
    return yield* Schema.decodeUnknownEffect(HouseholdJson)(text, DECODE_OPTIONS).pipe(
      Effect.mapError((error) =>
        new ConfigError({ path: target, message: `Файл ${target} не прошёл проверку: ${error.message}` })
      )
    )
  })

/** `<configDir>/item-aliases.json` (spec P4.2.3). A missing file gives an empty map. */
export const loadAliases = (
  configDir: string = DEFAULT_CONFIG_DIR
): Effect.Effect<Aliases, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const target = path.join(configDir, "item-aliases.json")
    const text = yield* readOptional(target)
    if (text === undefined) {
      return makeAliases({})
    }
    return yield* Schema.decodeUnknownEffect(AliasesJson)(text).pipe(
      Effect.map(makeAliases),
      Effect.mapError((error) =>
        new ConfigError({ path: target, message: `Файл ${target} не прошёл проверку: ${error.message}` })
      )
    )
  })
