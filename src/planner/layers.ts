import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Layer } from "effect"

/** The real file system and paths, for the commands of the planner. */
export const plannerLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
