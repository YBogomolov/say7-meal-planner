import { Console, Effect, FileSystem, Path } from "effect"
import type { Household } from "../domain/household.ts"
import { StoreError } from "../store/fs.ts"
import { loadCatalogue } from "./catalogue.ts"
import type { LoadedCatalogue } from "./catalogue.ts"
import { ConfigError, loadHousehold, loadPlannerConfig } from "./config.ts"
import type { PlannerConfig } from "./config.ts"
import { PlannerPaths } from "./paths.ts"
import { loadHistory } from "./plans.ts"
import type { LoadedHistory } from "./plans.ts"

type Services = FileSystem.FileSystem | Path.Path | PlannerPaths

/** The planner config and the catalogue that was built with it. */
export interface CatalogueWorld extends LoadedCatalogue {
  readonly config: PlannerConfig
}

/** Load the planner config, then the catalogue with it. */
export const loadCatalogueWorld: Effect.Effect<CatalogueWorld, ConfigError | StoreError, Services> = Effect.gen(
  function* () {
    const config = yield* loadPlannerConfig()
    const loaded = yield* loadCatalogue(config)
    return { config, ...loaded }
  }
)

/** The household, the config and the catalogue. */
export interface PlannerWorld extends CatalogueWorld {
  readonly household: Household
}

/** `PlannerWorld` and the history of the saved plans. */
export interface PlannerWorldWithHistory extends PlannerWorld {
  readonly history: LoadedHistory
}

/**
 * Load the household and the config (and the history, if `history` is true) concurrently, then the catalogue.
 * The same for every command that evaluates a plan (the CLIs and the MCP tools).
 */
export function loadPlannerWorld(options: {
  readonly history: true
}): Effect.Effect<PlannerWorldWithHistory, ConfigError | StoreError, Services>
export function loadPlannerWorld(options?: {
  readonly history?: false
}): Effect.Effect<PlannerWorld, ConfigError | StoreError, Services>
export function loadPlannerWorld(
  options: { readonly history?: boolean } = {}
): Effect.Effect<PlannerWorld | PlannerWorldWithHistory, ConfigError | StoreError, Services> {
  return Effect.gen(function* () {
    const [household, config, history] = yield* Effect.all(
      [loadHousehold(), loadPlannerConfig(), options.history === true ? loadHistory() : Effect.succeed(undefined)],
      { concurrency: "unbounded" }
    )
    const loaded = yield* loadCatalogue(config)
    return history === undefined ? { household, config, ...loaded } : { household, history, config, ...loaded }
  })
}

/** Print a warning on stderr for each recipe of the servings overrides that is not in the catalogue. */
export const warnUnknownOverrides = (unknownOverrides: LoadedCatalogue["unknownOverrides"]) =>
  Effect.forEach(
    unknownOverrides,
    (id) => Console.warn(`предупреждение: в servings-overrides.json есть рецепт ${id}, которого нет в каталоге.`),
    { discard: true }
  )
