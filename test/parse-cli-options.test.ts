import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { makeParseCommand } from "../src/parser/cli-options.ts"
import type { ParseCliOptions } from "../src/parser/cli-options.ts"
import { makeFixturesCommand } from "../src/parser/fixtures.ts"
import type { FixturesCliOptions } from "../src/parser/fixtures.ts"
import { commandTester } from "./support/cli.ts"

const parse = commandTester<ParseCliOptions>()(makeParseCommand)
const fixtures = commandTester<FixturesCliOptions>()(makeFixturesCommand)

describe("parse command", () => {
  it.effect("uses the defaults: all pages and the directory data", () =>
    Effect.gen(function* () {
      const options = yield* parse.parsed([])
      assert.isTrue(Option.isNone(options.ids))
      assert.strictEqual(options.dataDir, "data")
    })
  )

  it.effect("reads --ids and --data-dir", () =>
    Effect.gen(function* () {
      const options = yield* parse.parsed(["--ids", "1590, 7,18", "--data-dir", "/tmp/out"])
      assert.deepStrictEqual([...Option.getOrElse(options.ids, () => new Set())], [1590, 7, 18])
      assert.strictEqual(options.dataDir, "/tmp/out")
    })
  )

  it.effect("accepts the --flag=value form", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* parse.parsed(["--data-dir=/tmp/x"])).dataDir, "/tmp/x")
    })
  )

  it.effect("shows the help for --help and -h", () =>
    Effect.gen(function* () {
      const long = yield* parse.help(["--help"])
      assert.strictEqual(yield* parse.help(["-h"]), long)
      assert.include(long, "--ids")
      assert.include(long, "--data-dir")
    })
  )

  it.effect.each([
    { argv: ["--ids", "1,x"] },
    { argv: ["--ids", "0"] },
    { argv: ["--ids", ""] },
    { argv: ["--data-dir", ""] },
    { argv: ["--limit", "5"] },
    { argv: ["--force"] },
    { argv: ["extra"] },
    { argv: ["--ids"] },
  ])("rejects %j", ({ argv }) => parse.rejection(argv))

  it.effect("names the wrong option", () =>
    Effect.gen(function* () {
      assert.include(yield* parse.rejection(["--ids", "abc"]), "ids")
    })
  )
})

describe("fixtures:refresh command", () => {
  it.effect("uses the directory data by default", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* fixtures.parsed([]), { dataDir: "data" })
    })
  )

  it.effect("reads --data-dir and --help", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* fixtures.parsed(["--data-dir", "/tmp/d"]), { dataDir: "/tmp/d" })
      assert.include(yield* fixtures.help(["-h"]), "--data-dir")
    })
  )

  it.effect("rejects other options", () =>
    Effect.gen(function* () {
      yield* fixtures.rejection(["--ids", "1"])
      yield* fixtures.rejection(["extra"])
    })
  )
})
