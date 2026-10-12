import { Effect, FileSystem, Path } from "effect"
import { StoreError } from "../scraper/store.ts"

const TEMP_SUFFIX = ".tmp"

/**
 * Write a text file atomically: write `<target>.tmp` in the same directory, then rename it over `target`.
 * The directory is created if it does not exist. A failed write leaves no temporary file.
 */
export const writeTextAtomic = (
  target: string,
  text: string
): Effect.Effect<void, StoreError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const temp = `${target}${TEMP_SUFFIX}`
    yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(temp, text)),
      Effect.andThen(fs.rename(temp, target)),
      Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore))
    )
  }).pipe(Effect.mapError((error) => new StoreError({ path: target, message: error.message })))
