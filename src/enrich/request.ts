import type { ModelName } from "../domain/enriched-recipe.ts"
import { modelInputText } from "./input.ts"
import type { ModelInput } from "./input.ts"
import { MAX_OUTPUT_TOKENS } from "./llm-types.ts"
import type { LlmRequest } from "./llm-types.ts"
import { SYSTEM_PROMPT } from "./prompt.ts"

/** The request for one recipe: the system prompt, and the model input as the one user message. */
export const requestFor = (model: ModelName, recipe: { readonly input: ModelInput }): LlmRequest => ({
  model,
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: modelInputText(recipe.input) }],
  maxTokens: MAX_OUTPUT_TOKENS,
})
