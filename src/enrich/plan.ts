import { Option } from "effect"
import type { ModelName } from "../domain/enriched-recipe.ts"
import type { RunMode } from "../domain/enrich-report.ts"
import type { ParsedRecipe } from "../domain/parsed-recipe.ts"
import type { RecipeId } from "../domain/recipe.ts"
import { buildModelInput, computeInputHash, lineCount } from "./input.ts"
import type { ModelInput } from "./input.ts"
import { isInScope } from "./scope.ts"

/** A run with more recipes than this uses the Message Batches API, unless `--sync` is set (spec A5). */
export const BATCH_THRESHOLD = 20

/** Concurrent requests in sync mode (spec A5). */
export const SYNC_CONCURRENCY = 4

export interface PlannedRecipe {
  readonly id: RecipeId
  readonly input: ModelInput
  readonly lineCount: number
  readonly inputHash: string
}

export interface EnrichPlan {
  /** Recipes that need a call to the model, in ascending ID order, after `--limit`. */
  readonly toProcess: ReadonlyArray<PlannedRecipe>
  /** In-scope recipes whose stored file has the current `inputHash` (spec A8). */
  readonly cached: ReadonlyArray<RecipeId>
  /** Requested recipes with no category in the scope (spec P3.1). */
  readonly outOfScope: ReadonlyArray<RecipeId>
  /** Recipes that need a call but fall outside `--limit`. */
  readonly deferred: number
}

export interface IdSelection {
  /** IDs to read, in ascending order. */
  readonly selected: ReadonlyArray<RecipeId>
  /** Requested IDs that have no parsed file. */
  readonly unknown: ReadonlyArray<RecipeId>
}

/** The parsed IDs that the flag `--ids` selects. Without the flag, all of them. */
export const selectIds = (
  available: ReadonlyArray<RecipeId>,
  ids: Option.Option<ReadonlySet<RecipeId>>
): IdSelection => {
  const sorted = available.toSorted((a, b) => a - b)
  if (Option.isNone(ids)) {
    return { selected: sorted, unknown: [] }
  }
  const have = new Set(available)
  return {
    selected: sorted.filter((id) => ids.value.has(id)),
    unknown: [...ids.value].filter((id) => !have.has(id)).toSorted((a, b) => a - b)
  }
}

/**
 * Decide which recipes need the model.
 * A recipe is skipped if it is out of scope, or if its stored file has the same `inputHash` (spec A8).
 * `storedHashes` maps a recipe ID to the `inputHash` of its stored file.
 */
export const planEnrichment = (parts: {
  readonly recipes: ReadonlyArray<ParsedRecipe>
  readonly model: ModelName
  readonly promptVersion: number
  readonly storedHashes: ReadonlyMap<RecipeId, string>
  readonly limit: Option.Option<number>
}): EnrichPlan => {
  const outOfScope: Array<RecipeId> = []
  const cached: Array<RecipeId> = []
  const needed: Array<PlannedRecipe> = []

  for (const recipe of parts.recipes.toSorted((a, b) => a.id - b.id)) {
    if (!isInScope(recipe)) {
      outOfScope.push(recipe.id)
      continue
    }
    const input = buildModelInput(recipe)
    const inputHash = computeInputHash({ input, promptVersion: parts.promptVersion, model: parts.model })
    if (parts.storedHashes.get(recipe.id) === inputHash) {
      cached.push(recipe.id)
    } else {
      needed.push({ id: recipe.id, input, lineCount: lineCount(input), inputHash })
    }
  }

  const toProcess = Option.match(parts.limit, {
    onNone: () => needed,
    onSome: (limit) => needed.slice(0, limit)
  })
  return { toProcess, cached, outOfScope, deferred: needed.length - toProcess.length }
}

/** Batch for more than `BATCH_THRESHOLD` recipes, otherwise sync. `--sync` and `--retry-failed` force sync (spec A5, A9). */
export const chooseMode = (parts: {
  readonly count: number
  readonly sync: boolean
  readonly retryFailed: boolean
}): RunMode => (parts.sync || parts.retryFailed || parts.count <= BATCH_THRESHOLD ? "sync" : "batch")

/** `custom_id` of a batch request. The API accepts letters, digits, `_` and `-`, up to 64 characters. */
export const customIdOf = (id: RecipeId): string => `recipe-${id}`
