import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Layer } from "effect"
import { defaultHttpConfig, Http } from "./http.ts"
import type { HttpConfig } from "./http.ts"
import { Pacer } from "./pacer.ts"
import { RawStore } from "./store.ts"

export interface ScraperLayerConfig {
  readonly dataDir: string
  /** Base delay between requests in ms. */
  readonly delayMs: number
  readonly http?: HttpConfig
}

/** Real HTTP, the real file system, and the pacer. */
export const scraperLayer = (config: ScraperLayerConfig) =>
  Layer.mergeAll(
    Http.layer(config.http ?? defaultHttpConfig),
    Pacer.layer(config.delayMs),
    RawStore.layer(config.dataDir).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
  )
