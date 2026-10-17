import { assert, describe, it } from "@effect/vitest"
import { Option, Result } from "effect"
import { parseParseCli } from "../src/parser/cli-options.ts"
import type { ParseCliOptions } from "../src/parser/cli-options.ts"
import { parseFixturesCli } from "../src/parser/fixtures.ts"

const run = (...argv: ReadonlyArray<string>): ParseCliOptions => {
  const result = parseParseCli(argv)
  if (Result.isFailure(result)) {
    return assert.fail(`expected success, got: ${result.failure.message}`)
  }
  if (result.success._tag !== "Run") {
    return assert.fail("expected a run command")
  }
  return result.success.options
}

describe("parseParseCli", () => {
  it("uses the defaults: all pages and the directory data", () => {
    const options = run()
    assert.isTrue(Option.isNone(options.ids))
    assert.strictEqual(options.dataDir, "data")
  })

  it("reads --ids and --data-dir", () => {
    const options = run("--ids", "1590, 7,18", "--data-dir", "/tmp/out")
    assert.deepStrictEqual([...Option.getOrElse(options.ids, () => new Set())], [1590, 7, 18])
    assert.strictEqual(options.dataDir, "/tmp/out")
  })

  it("accepts the --flag=value form", () => {
    assert.strictEqual(run("--data-dir=/tmp/x").dataDir, "/tmp/x")
  })

  it("asks for help", () => {
    for (const flag of ["--help", "-h"]) {
      const result = parseParseCli([flag])
      assert.isTrue(Result.isSuccess(result) && result.success._tag === "Help")
    }
  })

  it.each([
    ["--ids", "1,x"],
    ["--ids", "0"],
    ["--ids", ""],
    ["--data-dir", ""],
    ["--limit", "5"],
    ["--force", ""],
  ])("rejects %s %s", (flag, value) => {
    assert.isTrue(Result.isFailure(parseParseCli(value === "" && flag === "--force" ? [flag] : [flag, value])))
  })

  it("rejects positional arguments and a missing value", () => {
    assert.isTrue(Result.isFailure(parseParseCli(["extra"])))
    assert.isTrue(Result.isFailure(parseParseCli(["--ids"])))
  })

  it("names the wrong option", () => {
    const result = parseParseCli(["--ids", "abc"])
    assert.isTrue(Result.isFailure(result) && result.failure.message.includes("ids"))
  })
})

describe("parseFixturesCli", () => {
  it("uses the directory data by default", () => {
    const result = parseFixturesCli([])
    assert.isTrue(Result.isSuccess(result) && result.success._tag === "Run" && result.success.dataDir === "data")
  })

  it("reads --data-dir and --help", () => {
    const run = parseFixturesCli(["--data-dir", "/tmp/d"])
    assert.isTrue(Result.isSuccess(run) && run.success._tag === "Run" && run.success.dataDir === "/tmp/d")
    const help = parseFixturesCli(["-h"])
    assert.isTrue(Result.isSuccess(help) && help.success._tag === "Help")
  })

  it("rejects other options", () => {
    assert.isTrue(Result.isFailure(parseFixturesCli(["--ids", "1"])))
    assert.isTrue(Result.isFailure(parseFixturesCli(["extra"])))
  })
})
