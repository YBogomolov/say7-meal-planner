import { Context, Layer } from "effect"

/** The directories that the planner reads and writes: `data/` for recipes and plans, `config/` for the settings. */
export interface PlannerPathsShape {
  readonly dataDir: string
  readonly configDir: string
}

export class PlannerPaths extends Context.Service<PlannerPaths, PlannerPathsShape>()("say7/planner/PlannerPaths") {
  static readonly layer = (paths: PlannerPathsShape): Layer.Layer<PlannerPaths> =>
    Layer.succeed(PlannerPaths, PlannerPaths.of(paths))
}
