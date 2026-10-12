import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Layer } from "effect"
import { ParseStore } from "./store.ts"

/** The real file system and the store on `<dataDir>`. */
export const parserLayer = (dataDir: string) =>
  ParseStore.layer(dataDir).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
