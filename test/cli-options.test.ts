import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  DEFAULT_BASE_URL,
  DEFAULT_DATA_DIR,
  DEFAULT_DELAY_MS,
  makeScrapeCommand,
  originOf,
} from "../src/scraper/cli-options.ts"
import type { CliOptions } from "../src/scraper/cli-options.ts"
import { commandTester } from "./support/cli.ts"

const scrape = commandTester<CliOptions>()(makeScrapeCommand)

describe("scrape command", () => {
  it.effect("uses the defaults of the spec", () =>
    Effect.gen(function* () {
      const options = yield* scrape.parsed([])
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
  )

  it.effect("reads every flag", () =>
    Effect.gen(function* () {
      const options = yield* scrape.parsed([
        "--limit",
        "20",
        "--ids",
        "12, 7,1590",
        "--force",
        "--delay-ms",
        "0",
        "--base-url",
        "http://127.0.0.1:8080/",
        "--data-dir",
        "/tmp/out",
      ])
      assert.strictEqual(Option.getOrNull(options.limit), 20)
      assert.deepStrictEqual([...Option.getOrElse(options.ids, () => new Set())], [12, 7, 1590])
      assert.isTrue(options.force)
      assert.strictEqual(options.delayMs, 0)
      assert.strictEqual(options.baseUrl, "http://127.0.0.1:8080")
      assert.strictEqual(options.dataDir, "/tmp/out")
    })
  )

  it.effect("accepts the --flag=value form", () =>
    Effect.gen(function* () {
      assert.strictEqual(Option.getOrNull((yield* scrape.parsed(["--limit=5"])).limit), 5)
    })
  )

  it.effect("shows the help for --help and -h, and names every flag", () =>
    Effect.gen(function* () {
      const long = yield* scrape.help(["--help"])
      const short = yield* scrape.help(["-h"])
      assert.strictEqual(short, long)
      for (const flag of ["--limit", "--ids", "--force", "--delay-ms", "--base-url", "--data-dir"]) {
        assert.include(long, flag)
      }
    })
  )

  it.effect.each([
    { argv: ["--limit", "0"] },
    { argv: ["--limit", "-3"] },
    { argv: ["--limit", "abc"] },
    { argv: ["--limit", "1.5"] },
    { argv: ["--ids", "1,x"] },
    { argv: ["--ids", "1,,2"] },
    { argv: ["--ids", ""] },
    { argv: ["--ids", "0"] },
    { argv: ["--delay-ms", "fast"] },
    { argv: ["--delay-ms", "1.5"] },
    { argv: ["--base-url", "ftp://example.com"] },
    { argv: ["--base-url", "not a url"] },
    { argv: ["--base-url", "https://example.com/path"] },
    { argv: ["--base-url", "https://example.com/?x=1"] },
    { argv: ["--data-dir", ""] },
    { argv: ["--unknown", "1"] },
  ])("rejects %j", ({ argv }) => scrape.rejection(argv))

  it.effect("rejects positional arguments and a missing value", () =>
    Effect.gen(function* () {
      yield* scrape.rejection(["extra"])
      yield* scrape.rejection(["--limit"])
    })
  )

  it.effect("explains which option is wrong", () =>
    Effect.gen(function* () {
      assert.include(yield* scrape.rejection(["--limit", "0"]), "limit")
    })
  )
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
