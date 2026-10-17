import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { makeEnrichCommand } from "../src/enrich/cli-options.ts"
import type { DryRunCliOptions, EnrichCliCommand, EnrichCliOptions } from "../src/enrich/cli-options.ts"
import { DEFAULT_GOLD_FILE, makeEvalCommand } from "../src/enrich/eval-cli-options.ts"
import type { EvalCliOptions } from "../src/enrich/eval-cli-options.ts"
import { commandTester } from "./support/cli.ts"

const enrich = commandTester<EnrichCliCommand>()(makeEnrichCommand)
const evaluation = commandTester<EvalCliOptions>()(makeEvalCommand)

const run = (...argv: ReadonlyArray<string>): Effect.Effect<EnrichCliOptions> =>
  enrich
    .parsed(argv)
    .pipe(Effect.map((command) => (command._tag === "Run" ? command.options : assert.fail("expected a run command"))))

const dry = (...argv: ReadonlyArray<string>): Effect.Effect<DryRunCliOptions> =>
  enrich
    .parsed(argv)
    .pipe(
      Effect.map((command) => (command._tag === "DryRun" ? command.options : assert.fail("expected a dry run command")))
    )

describe("enrich command", () => {
  it.effect("uses claude-haiku-5-5 when --model is missing", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* run()).model, "claude-haiku-5-5")
      assert.strictEqual((yield* run("--sync")).model, "claude-haiku-5-5")
    })
  )

  it.effect("keeps --model claude-sonnet-5-5 when it is given", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* run("--model", "claude-sonnet-5-5")).model, "claude-sonnet-5-5")
    })
  )

  it.effect("accepts the 2 models of the spec A6 and no other", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* run("--model", "claude-haiku-5-5")).model, "claude-haiku-5-5")
      assert.strictEqual((yield* run("--model=claude-sonnet-5-5")).model, "claude-sonnet-5-5")
      for (const model of ["claude-opus-5", "haiku", "", "claude-haiku-4-5"]) {
        yield* enrich.rejection(["--model", model])
      }
    })
  )

  it.effect("uses the defaults: all recipes, a run that decides the mode, the directory data/enriched", () =>
    Effect.gen(function* () {
      const options = yield* run("--model", "claude-haiku-5-5")
      assert.isTrue(Option.isNone(options.ids))
      assert.isTrue(Option.isNone(options.limit))
      assert.isFalse(options.sync)
      assert.isFalse(options.retryFailed)
      assert.strictEqual(options.dataDir, "data")
      assert.strictEqual(options.configDir, "config")
      assert.strictEqual(options.outDir, "data/enriched")
    })
  )

  it.effect("reads --config-dir, also with --dry-run", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* run("--model", "claude-haiku-5-5", "--config-dir", "/tmp/c")).configDir, "/tmp/c")
      assert.strictEqual((yield* dry("--dry-run", "--config-dir", "/tmp/c")).configDir, "/tmp/c")
      assert.strictEqual((yield* dry("--dry-run")).configDir, "config")
    })
  )

  it.effect("reads all options", () =>
    Effect.gen(function* () {
      const options = yield* run(
        "--model",
        "claude-sonnet-5-5",
        "--ids",
        "38, 61,246",
        "--limit",
        "5",
        "--sync",
        "--data-dir",
        "/tmp/d",
        "--out-dir",
        "/tmp/o"
      )
      assert.deepStrictEqual([...Option.getOrElse(options.ids, () => new Set())], [38, 61, 246])
      assert.deepStrictEqual(options.limit, Option.some(5))
      assert.isTrue(options.sync)
      assert.strictEqual(options.dataDir, "/tmp/d")
      assert.strictEqual(options.outDir, "/tmp/o")
    })
  )

  it.effect("puts the default out-dir inside the data-dir", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* run("--model", "claude-haiku-5-5", "--data-dir", "/tmp/d")).outDir, "/tmp/d/enriched")
    })
  )

  it.effect("accepts --retry-failed alone", () =>
    Effect.gen(function* () {
      assert.isTrue((yield* run("--model", "claude-haiku-5-5", "--retry-failed")).retryFailed)
    })
  )

  it.effect("refuses --retry-failed with --ids or --limit", () =>
    Effect.gen(function* () {
      assert.include(
        yield* enrich.rejection(["--model", "claude-haiku-5-5", "--retry-failed", "--ids", "5"]),
        "--retry-failed"
      )
      assert.include(
        yield* enrich.rejection(["--model", "claude-haiku-5-5", "--retry-failed", "--limit", "5"]),
        "--retry-failed"
      )
    })
  )

  it.effect.each([
    { extra: ["--limit", "0"] },
    { extra: ["--limit", "-3"] },
    { extra: ["--limit", "x"] },
    { extra: ["--limit", "1.5"] },
    { extra: ["--ids", "1,x"] },
    { extra: ["--ids", "0"] },
    { extra: ["--ids", ""] },
    { extra: ["--data-dir", ""] },
    { extra: ["--out-dir", ""] },
    { extra: ["--force"] },
    { extra: ["extra"] },
  ])("rejects %j", ({ extra }) => enrich.rejection(["--model", "claude-haiku-5-5", ...extra]))

  it.effect("shows the help for --help and -h", () =>
    Effect.gen(function* () {
      const long = yield* enrich.help(["--help"])
      assert.strictEqual(yield* enrich.help(["-h"]), long)
    })
  )

  describe("--dry-run", () => {
    it.effect("needs no --model: it estimates both models", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual((yield* dry("--dry-run")).models, ["claude-haiku-5-5", "claude-sonnet-5-5"])
      })
    )

    it.effect("estimates only the model of --model", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual((yield* dry("--dry-run", "--model", "claude-sonnet-5-5")).models, ["claude-sonnet-5-5"])
      })
    )

    it.effect("rejects a model that is not supported, also in a dry run", () =>
      enrich.rejection(["--dry-run", "--model", "claude-opus-5"])
    )

    it.effect("reads the other flags and uses the same defaults", () =>
      Effect.gen(function* () {
        const defaults = yield* dry("--dry-run")
        assert.isTrue(Option.isNone(defaults.ids))
        assert.isTrue(Option.isNone(defaults.limit))
        assert.isFalse(defaults.sync)
        assert.isFalse(defaults.retryFailed)
        assert.strictEqual(defaults.dataDir, "data")
        assert.strictEqual(defaults.outDir, "data/enriched")

        const options = yield* dry(
          "--dry-run",
          "--ids",
          "38,61",
          "--limit",
          "5",
          "--sync",
          "--data-dir",
          "/tmp/d",
          "--out-dir",
          "/tmp/o"
        )
        assert.deepStrictEqual([...Option.getOrElse(options.ids, () => new Set())], [38, 61])
        assert.deepStrictEqual(options.limit, Option.some(5))
        assert.isTrue(options.sync)
        assert.strictEqual(options.dataDir, "/tmp/d")
        assert.strictEqual(options.outDir, "/tmp/o")
      })
    )

    it.effect("keeps the rule that --retry-failed does not go with --ids or --limit", () =>
      Effect.gen(function* () {
        assert.isTrue((yield* dry("--dry-run", "--retry-failed")).retryFailed)
        assert.include(yield* enrich.rejection(["--dry-run", "--retry-failed", "--ids", "5"]), "--retry-failed")
      })
    )

    it.effect("is not a dry run without the flag", () =>
      Effect.gen(function* () {
        assert.strictEqual((yield* run("--limit", "5")).model, "claude-haiku-5-5")
      })
    )
  })

  it.effect("describes every option in the help text", () =>
    Effect.gen(function* () {
      const help = yield* enrich.help()
      for (const flag of [
        "--model",
        "--ids",
        "--limit",
        "--sync",
        "--retry-failed",
        "--data-dir",
        "--out-dir",
        "--dry-run",
        "--help",
      ]) {
        assert.include(help, flag)
      }
      assert.include(help, "ANTHROPIC_API_KEY")
    })
  )
})

describe("enrich:eval command", () => {
  it.effect("uses the defaults", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* evaluation.parsed([]), {
        dataDir: "data",
        outDir: "data/enriched",
        goldFile: DEFAULT_GOLD_FILE,
      })
      assert.match(DEFAULT_GOLD_FILE, /test\/fixtures\/gold\.json$/)
    })
  )

  it.effect("reads the options", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* evaluation.parsed(["--out-dir", "o", "--data-dir", "d", "--gold", "g.json"]), {
        dataDir: "d",
        outDir: "o",
        goldFile: "g.json",
      })
    })
  )

  it.effect("rejects an unknown option and an empty value", () =>
    Effect.gen(function* () {
      yield* evaluation.rejection(["--model", "x"])
      yield* evaluation.rejection(["--out-dir", ""])
    })
  )

  it.effect("shows the help", () =>
    Effect.gen(function* () {
      assert.include(yield* evaluation.help(["-h"]), "--gold")
    })
  )
})
