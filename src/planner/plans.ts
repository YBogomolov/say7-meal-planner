import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { PLAN_DECODE_OPTIONS, WeekPlan, WeekPlanJson } from "../domain/week-plan.ts"
import { StoreError } from "../scraper/store.ts"
import { writeTextAtomic } from "./atomic.ts"

const PLAN_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/

/** The input of `savePlan` is not a valid plan. The message is Russian text with the details of the decoder. */
export class PlanInvalidError extends Schema.TaggedError<PlanInvalidError>()("PlanInvalidError", {
  message: Schema.String,
}) {}

export interface SavedPlan {
  readonly plan: WeekPlan
  /** The file that was written: `<dataDir>/plans/<weekStart>.json`. */
  readonly path: string
}

/** A file of `data/plans/` that `loadHistory` could not use. */
export interface SkippedPlanFile {
  readonly file: string
  readonly message: string
}

export interface LoadedHistory {
  /** The valid plans, oldest week first. */
  readonly plans: ReadonlyArray<WeekPlan>
  readonly skipped: ReadonlyArray<SkippedPlanFile>
}

const invalid = (error: { readonly message: string }) =>
  new PlanInvalidError({
    message: `План не прошёл проверку.\n${error.message}`,
  })

/** Decode the input as a `WeekPlan`: every problem of the shape is in the message. */
export const decodePlan = (input: unknown): Effect.Effect<WeekPlan, PlanInvalidError> =>
  Schema.decodeUnknownEffect(WeekPlan)(input, PLAN_DECODE_OPTIONS).pipe(Effect.mapError(invalid))

/** Decode the JSON text of a plan. */
export const decodePlanJson = (text: string): Effect.Effect<WeekPlan, PlanInvalidError> =>
  Schema.decodeUnknownEffect(WeekPlanJson)(text, PLAN_DECODE_OPTIONS).pipe(Effect.mapError(invalid))

/**
 * Check the shape of a plan and write it to `<dataDir>/plans/<weekStart>.json` atomically (spec P4.6.1).
 * The check is the decoder only. A plan that breaks the rules of the household is saved too: `evaluatePlan` judges it.
 * A plan of the same week is replaced.
 */
export const savePlan = (
  dataDir: string,
  input: unknown
): Effect.Effect<SavedPlan, PlanInvalidError | StoreError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const plan = yield* decodePlan(input)
    const target = path.join(dataDir, "plans", `${plan.weekStart}.json`)
    const text = yield* Schema.encodeEffect(WeekPlanJson)(plan).pipe(
      Effect.mapError((error) => new StoreError({ path: target, message: error.message }))
    )
    yield* writeTextAtomic(target, `${text}\n`)
    return { plan, path: target }
  })

/**
 * Read all plans of `<dataDir>/plans/` (spec P4.6.1). A missing directory is an empty history.
 * A file that is not valid, or whose name differs from its `weekStart`, is in `skipped`.
 */
export const loadHistory = (
  dataDir: string
): Effect.Effect<LoadedHistory, StoreError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = path.join(dataDir, "plans")
    const ioError = (error: { readonly message: string }) => new StoreError({ path: dir, message: error.message })
    if (!(yield* fs.exists(dir).pipe(Effect.mapError(ioError)))) {
      return { plans: [], skipped: [] }
    }
    const names = (yield* fs.readDirectory(dir).pipe(Effect.mapError(ioError)))
      .filter((name) => PLAN_FILE.test(name))
      .sort()
    const results = yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          const text = yield* fs
            .readFileString(path.join(dir, name))
            .pipe(Effect.mapError((error) => `Файл не читается: ${error.message}`))
          const plan = yield* Schema.decodeUnknownEffect(WeekPlanJson)(text).pipe(
            Effect.mapError((error) => `Файл не прошёл проверку: ${error.message}`)
          )
          return plan.weekStart === name.slice(0, -".json".length)
            ? plan
            : yield* Effect.fail(`Имя файла не совпадает с weekStart внутри файла (${plan.weekStart}).`)
        }).pipe(
          Effect.result,
          Effect.map((result) => ({ name, result }))
        ),
      { concurrency: 8 }
    )
    return {
      plans: results.flatMap(({ result }) => (Result.isSuccess(result) ? [result.success] : [])),
      skipped: results.flatMap(({ name, result }) =>
        Result.isFailure(result) ? [{ file: path.join(dir, name), message: result.failure }] : []
      ),
    }
  })
