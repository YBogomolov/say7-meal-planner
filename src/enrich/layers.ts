import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Config, Effect, Layer, Redacted } from "effect"
import { Llm } from "./api.ts"
import { EnrichRunError } from "./run.ts"
import { EnrichStore } from "./store.ts"

export const API_KEY_VARIABLE = "ANTHROPIC_API_KEY"

/** The real file system and the store on `<data-dir>/parsed` and `<out-dir>`. */
export const enrichStoreLayer = (config: { readonly dataDir: string; readonly outDir: string }) =>
  EnrichStore.layer(config).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

/**
 * The Anthropic API with the key from the environment variable `ANTHROPIC_API_KEY` (spec A1).
 * The key stays in `Redacted`. The layer fails with a clear message if the key is not set.
 */
export const llmLayer: Layer.Layer<Llm, EnrichRunError> = Layer.unwrap(
  Config.Redacted(API_KEY_VARIABLE).pipe(
    Effect.mapError(
      () =>
        new EnrichRunError({
          message: `The variable ${API_KEY_VARIABLE} is not set. Put it in the environment or in a .env file.`
        })
    ),
    Effect.filterOrFail(
      (key) => Redacted.value(key).trim() !== "",
      () => new EnrichRunError({ message: `The variable ${API_KEY_VARIABLE} is empty.` })
    ),
    Effect.map((apiKey) => Llm.layer({ apiKey }))
  )
)
