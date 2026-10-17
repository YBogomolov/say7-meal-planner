import { Effect, FileSystem, Path, Schema } from "effect"

/** A file or directory operation of a store failed. */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** The suffix of the temporary file of an atomic write. */
export const TEMP_SUFFIX = ".tmp"

/** Turn the error of a file operation on `target` into a `StoreError`. */
export const io = <A, E extends { readonly message: string }, R>(
  target: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, StoreError, R> =>
  effect.pipe(Effect.mapError((error) => new StoreError({ path: target, message: error.message })))

/**
 * Write a file atomically: write `<target>.tmp` in the same directory, then rename it over `target`.
 * The directory is created if it does not exist. A failed write leaves no temporary file.
 */
export const writeFileAtomic = (
  target: string,
  data: Uint8Array
): Effect.Effect<void, StoreError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const temp = `${target}${TEMP_SUFFIX}`
    yield* io(
      target,
      fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
        Effect.andThen(fs.writeFile(temp, data)),
        Effect.andThen(fs.rename(temp, target)),
        Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore))
      )
    )
  })

/** Like `writeFileAtomic`, for UTF-8 text. */
export const writeTextAtomic = (
  target: string,
  text: string
): Effect.Effect<void, StoreError, FileSystem.FileSystem | Path.Path> =>
  writeFileAtomic(target, new TextEncoder().encode(text))
