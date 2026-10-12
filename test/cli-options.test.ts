import { assert, describe, it } from "@effect/vitest"
import { Option, Result } from "effect"
import { DEFAULT_BASE_URL, DEFAULT_DATA_DIR, DEFAULT_DELAY_MS, originOf, parseCli } from "../src/scraper/cli-options.ts"
import type { CliOptions } from "../src/scraper/cli-options.ts"

const run = (...argv: ReadonlyArray<string>): CliOptions => {
  const result = parseCli(argv)
  if (Result.isFailure(result)) {
    return assert.fail(`expected success, got: ${result.failure.message}`)
  }
  if (result.success._tag !== "Run") {
    return assert.fail("expected a run command")
  }
  return result.success.options
}

const failure = (...argv: ReadonlyArray<string>): string => {
  const result = parseCli(argv)
  return Result.isFailure(result) ? result.failure.message : assert.fail("expected a failure")
}

describe("parseCli", () => {
  it("uses the defaults of the spec", () => {
    const options = run()
    assert.isTrue(Option.isNone(options.limit))
    assert.isTrue(Option.isNone(options.ids))
    assert.isFalse(options.force)
    assert.strictEqual(options.delayMs, DEFAULT_DELAY_MS)
    assert.strictEqual(options.delayMs, 2500)
    assert.strictEqual(options.baseUrl, DEFAULT_BASE_URL)
    assert.strictEqual(options.baseUrl, "https://www.say7.info")
    assert.strictEqual(options.dataDir, DEFAULT_DATA_DIR)
    assert.strictEqual(options.dataDir, "data")
  })

  it("reads every flag", () => {
    const options = run(
      "--limit", "20",
      "--ids", "12, 7,1590",
      "--force",
      "--delay-ms", "0",
      "--base-url", "http://127.0.0.1:8080/",
      "--data-dir", "/tmp/out"
    )
    assert.strictEqual(Option.getOrNull(options.limit), 20)
    assert.deepStrictEqual([...Option.getOrElse(options.ids, () => new Set())], [12, 7, 1590])
    assert.isTrue(options.force)
    assert.strictEqual(options.delayMs, 0)
    assert.strictEqual(options.baseUrl, "http://127.0.0.1:8080")
    assert.strictEqual(options.dataDir, "/tmp/out")
  })

  it("accepts the --flag=value form", () => {
    assert.strictEqual(Option.getOrNull(run("--limit=5").limit), 5)
  })

  it("asks for help", () => {
    const result = parseCli(["--help"])
    assert.isTrue(Result.isSuccess(result) && result.success._tag === "Help")
    const short = parseCli(["-h"])
    assert.isTrue(Result.isSuccess(short) && short.success._tag === "Help")
  })

  it.each([
    ["--limit", "0"],
    ["--limit", "-3"],
    ["--limit", "abc"],
    ["--limit", "1.5"],
    ["--ids", "1,x"],
    ["--ids", "1,,2"],
    ["--ids", ""],
    ["--ids", "0"],
    ["--delay-ms", "fast"],
    ["--delay-ms", "1.5"],
    ["--base-url", "ftp://example.com"],
    ["--base-url", "not a url"],
    ["--base-url", "https://example.com/path"],
    ["--base-url", "https://example.com/?x=1"],
    ["--data-dir", ""],
    ["--unknown", "1"]
  ])("rejects %s %s", (flag, value) => {
    const result = parseCli([flag, value])
    assert.isTrue(Result.isFailure(result))
  })

  it("rejects positional arguments and a missing value", () => {
    assert.include(failure("extra"), "positional")
    assert.isTrue(Result.isFailure(parseCli(["--limit"])))
  })

  it("explains which option is wrong", () => {
    assert.include(failure("--limit", "0"), "limit")
  })
})

describe("originOf", () => {
  it("returns the origin without a trailing slash", () => {
    assert.strictEqual(Option.getOrNull(originOf("https://www.say7.info")), "https://www.say7.info")
    assert.strictEqual(Option.getOrNull(originOf("https://www.say7.info/")), "https://www.say7.info")
    assert.strictEqual(Option.getOrNull(originOf("http://127.0.0.1:9000/")), "http://127.0.0.1:9000")
  })

  it("rejects a path, credentials and other schemes", () => {
    assert.isTrue(Option.isNone(originOf("https://www.say7.info/cook")))
    assert.isTrue(Option.isNone(originOf("https://user:pw@www.say7.info")))
    assert.isTrue(Option.isNone(originOf("file:///tmp")))
  })
})
