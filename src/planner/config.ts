import { Effect, FileSystem, Path, Schema } from "effect"
import { PlannerPaths } from "./paths.ts"
import type { Aliases, ProteinTable } from "../domain/catalogue.ts"
import { DECODE_OPTIONS, DEFAULT_HOUSEHOLD, HouseholdJson } from "../domain/household.ts"
import type { Household } from "../domain/household.ts"
import { AliasesJson, makeAliases, NO_ALIASES } from "./items.ts"
import { ItemProteinJson, makeProteinTable, NO_PROTEIN } from "./protein.ts"
import type { SimpleBreakfast } from "../domain/simple-breakfast.ts"
import type { CatalogueExtras } from "./catalogue.ts"
import { makeSimpleBreakfasts, NO_SIMPLE_BREAKFASTS, SimpleBreakfastsJson } from "./simple.ts"
import { makeServingsOverrides, NO_SERVINGS_OVERRIDES, ServingsOverridesJson } from "./servings.ts"
import type { ServingsOverrides } from "./servings.ts"

/** A file of `config/` exists but cannot be read, or it is not valid. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** The text of a config file, or `undefined` if the file does not exist. */
const readOptional = (target: string): Effect.Effect<string | undefined, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(target))) {
      return undefined
    }
    return yield* fs.readFileString(target)
  }).pipe(
    Effect.mapError(
      (error) =>
        new ConfigError({
          path: target,
          message: `Файл ${target} не читается: ${error.message}`,
        })
    )
  )

/** `<configDir>/household.json` (spec P4.1). A missing file gives the defaults of the spec. */
export const loadHousehold = (): Effect.Effect<
  Household,
  ConfigError,
  FileSystem.FileSystem | Path.Path | PlannerPaths
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const { configDir } = yield* PlannerPaths
    const target = path.join(configDir, "household.json")
    const text = yield* readOptional(target)
    if (text === undefined) {
      return DEFAULT_HOUSEHOLD
    }
    return yield* Schema.decodeUnknownEffect(HouseholdJson)(text, DECODE_OPTIONS).pipe(
      Effect.mapError(
        (error) =>
          new ConfigError({
            path: target,
            message: `Файл ${target} не прошёл проверку: ${error.message}`,
          })
      )
    )
  })

/** `<configDir>/item-aliases.json` (spec P4.2.3). A missing file gives an empty map. */
export const loadAliases = (): Effect.Effect<Aliases, ConfigError, FileSystem.FileSystem | Path.Path | PlannerPaths> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const { configDir } = yield* PlannerPaths
    const target = path.join(configDir, "item-aliases.json")
    const text = yield* readOptional(target)
    if (text === undefined) {
      return makeAliases({})
    }
    return yield* Schema.decodeUnknownEffect(AliasesJson)(text).pipe(
      Effect.map(makeAliases),
      Effect.mapError(
        (error) =>
          new ConfigError({
            path: target,
            message: `Файл ${target} не прошёл проверку: ${error.message}`,
          })
      )
    )
  })

/** `<configDir>/servings-overrides.json` (handoff T2). A missing file gives an empty map. */
export const loadServingsOverrides = (): Effect.Effect<
  ServingsOverrides,
  ConfigError,
  FileSystem.FileSystem | Path.Path | PlannerPaths
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const { configDir } = yield* PlannerPaths
    const target = path.join(configDir, "servings-overrides.json")
    const text = yield* readOptional(target)
    if (text === undefined) {
      return NO_SERVINGS_OVERRIDES
    }
    return yield* Schema.decodeUnknownEffect(ServingsOverridesJson)(text).pipe(
      Effect.map(makeServingsOverrides),
      Effect.mapError(
        (error) =>
          new ConfigError({
            path: target,
            message: `Файл ${target} не прошёл проверку: ${error.message}`,
          })
      )
    )
  })

/**
 * `<configDir>/item-protein.json` (spec P7.1.1). A missing file gives an empty table.
 * The item names are cleaned and mapped through `aliases`, like the items of the catalogue.
 */
export const loadItemProtein = (
  aliases: Aliases = NO_ALIASES
): Effect.Effect<ProteinTable, ConfigError, FileSystem.FileSystem | Path.Path | PlannerPaths> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const { configDir } = yield* PlannerPaths
    const target = path.join(configDir, "item-protein.json")
    const text = yield* readOptional(target)
    if (text === undefined) {
      return NO_PROTEIN
    }
    return yield* Schema.decodeUnknownEffect(ItemProteinJson)(text).pipe(
      Effect.map((record) => makeProteinTable(record, aliases)),
      Effect.mapError(
        (error) =>
          new ConfigError({
            path: target,
            message: `Файл ${target} не прошёл проверку: ${error.message}`,
          })
      )
    )
  })

/**
 * `<configDir>/simple-breakfasts.json` (spec P7.2.3). A missing file gives an empty list.
 * The item names are cleaned and mapped through `aliases`, like the items of the catalogue.
 */
export const loadSimpleBreakfasts = (
  aliases: Aliases = NO_ALIASES
): Effect.Effect<ReadonlyArray<SimpleBreakfast>, ConfigError, FileSystem.FileSystem | Path.Path | PlannerPaths> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const { configDir } = yield* PlannerPaths
    const target = path.join(configDir, "simple-breakfasts.json")
    const text = yield* readOptional(target)
    if (text === undefined) {
      return NO_SIMPLE_BREAKFASTS
    }
    return yield* Schema.decodeUnknownEffect(SimpleBreakfastsJson)(text).pipe(
      Effect.map((records) => makeSimpleBreakfasts(records, aliases)),
      Effect.mapError(
        (error) =>
          new ConfigError({
            path: target,
            message: `Файл ${target} не прошёл проверку: ${error.message}`,
          })
      )
    )
  })

/** What `loadCatalogue` takes from the config besides the protein table: the simple breakfasts and `household.breakfastExtraIds`. */
export const loadCatalogueExtras = (
  aliases: Aliases = NO_ALIASES
): Effect.Effect<CatalogueExtras, ConfigError, FileSystem.FileSystem | Path.Path | PlannerPaths> =>
  Effect.gen(function* () {
    const [household, simpleBreakfasts] = yield* Effect.all([loadHousehold(), loadSimpleBreakfasts(aliases)], {
      concurrency: "unbounded",
    })
    return { simpleBreakfasts, breakfastExtraIds: household.breakfastExtraIds }
  })

export interface PlannerConfig {
  readonly aliases: Aliases
  readonly overrides: ServingsOverrides
  readonly proteinTable: ProteinTable
  readonly extras: CatalogueExtras
}

/** The config that every CLI and the MCP server pass to `loadCatalogue`. The files load concurrently; the protein table and the extras need `aliases`. */
export const loadPlannerConfig = (): Effect.Effect<
  PlannerConfig,
  ConfigError,
  FileSystem.FileSystem | Path.Path | PlannerPaths
> =>
  Effect.gen(function* () {
    const [aliases, overrides] = yield* Effect.all([loadAliases(), loadServingsOverrides()], {
      concurrency: "unbounded",
    })
    const [proteinTable, extras] = yield* Effect.all([loadItemProtein(aliases), loadCatalogueExtras(aliases)], {
      concurrency: "unbounded",
    })
    return { aliases, overrides, proteinTable, extras }
  })
