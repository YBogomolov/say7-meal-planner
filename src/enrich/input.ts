import type { ParsedRecipe } from "../domain/parsed-recipe.ts"
import type { ModelName } from "../domain/enriched-recipe.ts"
import { sha256Hex } from "../scraper/hash.ts"

/** One ingredient line with its number over all groups, counted from 0. */
export type NumberedLine = { readonly line: number; readonly text: string }

export type NumberedGroup = {
  readonly title: string | null
  readonly lines: ReadonlyArray<NumberedLine>
}

/**
 * What the model gets for one recipe (spec P3.3):
 * title, intro, yield, servings text, ingredient groups with line numbers, steps and category names.
 * The model does not get the comments, the dates, the similar recipes or the times that the parser found.
 */
export type ModelInput = {
  readonly title: string
  readonly intro: ReadonlyArray<string>
  readonly yieldText: string | null
  readonly servingsText: string | null
  readonly ingredientGroups: ReadonlyArray<NumberedGroup>
  readonly steps: ReadonlyArray<string>
  readonly categories: ReadonlyArray<string>
}

/** The numbers 0 to n-1 run over all groups, in the order of the page. */
export const numberGroups = (groups: ParsedRecipe["ingredientGroups"]): ReadonlyArray<NumberedGroup> => {
  let next = 0
  return groups.map((group) => ({
    title: group.title,
    lines: group.items.map((text) => ({ line: next++, text })),
  }))
}

export const buildModelInput = (recipe: ParsedRecipe): ModelInput => ({
  title: recipe.title,
  intro: recipe.intro,
  yieldText: recipe.yieldText,
  servingsText: recipe.servingsText,
  ingredientGroups: numberGroups(recipe.ingredientGroups),
  steps: recipe.steps,
  categories: recipe.categories.map((category) => category.name),
})

/** Number of ingredient lines, over all groups. */
export const lineCount = (input: ModelInput): number =>
  input.ingredientGroups.reduce((total, group) => total + group.lines.length, 0)

/** Every ingredient line of the input, in the order of the numbers. */
export const allLines = (input: ModelInput): ReadonlyArray<NumberedLine> =>
  input.ingredientGroups.flatMap((group) => group.lines)

/** A value that `JSON.stringify` writes without loss. */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

/**
 * JSON text without white space, with the keys of every object in code point order.
 * The same value always gives the same text. Cyrillic letters stay as they are.
 */
export const canonicalJson = (value: Json): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  }
  const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
}

/** The text of the user message: the canonical JSON of the input. */
export const modelInputText = (input: ModelInput): string => canonicalJson(input)

/**
 * `inputHash` of spec A8: SHA-256 of the canonical JSON of the input, the prompt version and the model.
 * A change of any of the three makes the stored file stale.
 */
export const computeInputHash = (parts: {
  readonly input: ModelInput
  readonly promptVersion: number
  readonly model: ModelName
}): string =>
  sha256Hex(
    new TextEncoder().encode(
      canonicalJson({
        input: parts.input,
        model: parts.model,
        promptVersion: parts.promptVersion,
      })
    )
  )
