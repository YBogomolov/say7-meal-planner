import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Layer } from "effect"
import { PlannerPaths } from "./paths.ts"
import type { PlannerPathsShape } from "./paths.ts"

/** The real file system and paths, for the commands of the planner. */
export const plannerLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** `plannerLayer` and the directories `paths`. Everything that the loaders of the planner need. */
export const plannerLayerFor = (paths: PlannerPathsShape) => Layer.mergeAll(plannerLayer, PlannerPaths.layer(paths))
