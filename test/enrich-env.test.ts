import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { loadDotEnv } from "../src/enrich/env.ts"

const NAME = "SAY7_TEST_ENV_VALUE"
const OTHER = "SAY7_TEST_ENV_OTHER"

describe("loadDotEnv", () => {
  let dir = ""

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "say7-env-"))
    delete process.env[NAME]
    delete process.env[OTHER]
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env[NAME]
    delete process.env[OTHER]
  })

  it.live("loads the variables of the file", () =>
    Effect.gen(function*() {
      const file = join(dir, ".env")
      writeFileSync(file, `# comment\n${NAME}=from-file\n${OTHER}="quoted value"\n`)
      assert.isTrue(yield* loadDotEnv(file))
      assert.strictEqual(process.env[NAME], "from-file")
      assert.strictEqual(process.env[OTHER], "quoted value")
    }))

  it.live("keeps a variable that the environment already has", () =>
    Effect.gen(function*() {
      const file = join(dir, ".env")
      writeFileSync(file, `${NAME}=from-file\n`)
      process.env[NAME] = "from-environment"
      assert.isTrue(yield* loadDotEnv(file))
      assert.strictEqual(process.env[NAME], "from-environment")
    }))

  it.live("returns false and changes nothing when the file does not exist", () =>
    Effect.gen(function*() {
      assert.isFalse(yield* loadDotEnv(join(dir, "absent.env")))
      assert.isUndefined(process.env[NAME])
    }))

  it.live("fails with an EnvFileError, without the content, when the path is a directory", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(loadDotEnv(dir))
      assert.strictEqual(error._tag, "EnvFileError")
      assert.strictEqual(error.path, dir)
    }))
})
