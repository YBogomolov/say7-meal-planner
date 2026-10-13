import { assert, describe, it } from "@effect/vitest"
import { Option, Result } from "effect"
import { parseEnrichCli, USAGE } from "../src/enrich/cli-options.ts"
import type { DryRunCliOptions, EnrichCliOptions } from "../src/enrich/cli-options.ts"
import { DEFAULT_GOLD_FILE, parseEvalCli } from "../src/enrich/eval-cli-options.ts"

const run = (...argv: ReadonlyArray<string>): EnrichCliOptions => {
  const result = parseEnrichCli(argv)
  if (Result.isFailure(result)) {
    return assert.fail(`expected success, got: ${result.failure.message}`)
  }
  if (result.success._tag !== "Run") {
    return assert.fail("expected a run command")
  }
  return result.success.options
}

const dry = (...argv: ReadonlyArray<string>): DryRunCliOptions => {
  const result = parseEnrichCli(argv)
  if (Result.isFailure(result)) {
    return assert.fail(`expected success, got: ${result.failure.message}`)
  }
  if (result.success._tag !== "DryRun") {
    return assert.fail("expected a dry run command")
  }
  return result.success.options
}

const failure = (...argv: ReadonlyArray<string>): string => {
  const result = parseEnrichCli(argv)
  return Result.isFailure(result) ? result.failure.message : assert.fail("expected a failure")
}

describe("parseEnrichCli", () => {
  it("uses claude-haiku-5-5 when --model is missing", () => {
    assert.strictEqual(run().model, "claude-haiku-5-5")
    assert.strictEqual(run("--sync").model, "claude-haiku-5-5")
  })

  it("keeps --model claude-sonnet-5-5 when it is given", () => {
    assert.strictEqual(run("--model", "claude-sonnet-5-5").model, "claude-sonnet-5-5")
  })

  it("accepts the 2 models of the spec A6 and no other", () => {
    assert.strictEqual(run("--model", "claude-haiku-5-5").model, "claude-haiku-5-5")
    assert.strictEqual(run("--model=claude-sonnet-5-5").model, "claude-sonnet-5-5")
    for (const model of ["claude-opus-5", "haiku", "", "claude-haiku-4-5"]) {
      assert.isTrue(Result.isFailure(parseEnrichCli(["--model", model])), model)
    }
  })

  it("uses the defaults: all recipes, a run that decides the mode, the directory data/enriched", () => {
    const options = run("--model", "claude-haiku-5-5")
    assert.isTrue(Option.isNone(options.ids))
    assert.isTrue(Option.isNone(options.limit))
    assert.isFalse(options.sync)
    assert.isFalse(options.retryFailed)
    assert.strictEqual(options.dataDir, "data")
    assert.strictEqual(options.outDir, "data/enriched")
  })

  it("reads all options", () => {
    const options = run(
      "--model", "claude-sonnet-5-5", "--ids", "38, 61,246", "--limit", "5", "--sync",
      "--data-dir", "/tmp/d", "--out-dir", "/tmp/o"
    )
    assert.deepStrictEqual([...Option.getOrElse(options.ids, () => new Set())], [38, 61, 246])
    assert.deepStrictEqual(options.limit, Option.some(5))
    assert.isTrue(options.sync)
    assert.strictEqual(options.dataDir, "/tmp/d")
    assert.strictEqual(options.outDir, "/tmp/o")
  })

  it("puts the default out-dir inside the data-dir", () => {
    assert.strictEqual(run("--model", "claude-haiku-5-5", "--data-dir", "/tmp/d").outDir, "/tmp/d/enriched")
  })

  it("accepts --retry-failed alone", () => {
    assert.isTrue(run("--model", "claude-haiku-5-5", "--retry-failed").retryFailed)
  })

  it("refuses --retry-failed with --ids or --limit", () => {
    assert.include(failure("--model", "claude-haiku-5-5", "--retry-failed", "--ids", "5"), "--retry-failed")
    assert.include(failure("--model", "claude-haiku-5-5", "--retry-failed", "--limit", "5"), "--retry-failed")
  })

  it.each([
    [["--limit", "0"]],
    [["--limit", "-3"]],
    [["--limit", "x"]],
    [["--limit", "1.5"]],
    [["--ids", "1,x"]],
    [["--ids", "0"]],
    [["--ids", ""]],
    [["--data-dir", ""]],
    [["--out-dir", ""]],
    [["--force"]],
    [["extra"]]
  ])("rejects %j", (extra) => {
    assert.isTrue(Result.isFailure(parseEnrichCli(["--model", "claude-haiku-5-5", ...extra])))
  })

  it("asks for help", () => {
    for (const flag of ["--help", "-h"]) {
      const result = parseEnrichCli([flag])
      assert.isTrue(Result.isSuccess(result) && result.success._tag === "Help")
    }
  })

  describe("--dry-run", () => {
    it("needs no --model: it estimates both models", () => {
      assert.deepStrictEqual(dry("--dry-run").models, ["claude-haiku-5-5", "claude-sonnet-5-5"])
    })

    it("estimates only the model of --model", () => {
      assert.deepStrictEqual(dry("--dry-run", "--model", "claude-sonnet-5-5").models, ["claude-sonnet-5-5"])
    })

    it("rejects a model that is not supported, also in a dry run", () => {
      assert.isTrue(Result.isFailure(parseEnrichCli(["--dry-run", "--model", "claude-opus-5"])))
    })

    it("reads the other flags and uses the same defaults", () => {
      const defaults = dry("--dry-run")
      assert.isTrue(Option.isNone(defaults.ids))
      assert.isTrue(Option.isNone(defaults.limit))
      assert.isFalse(defaults.sync)
      assert.isFalse(defaults.retryFailed)
      assert.strictEqual(defaults.dataDir, "data")
      assert.strictEqual(defaults.outDir, "data/enriched")

      const options = dry("--dry-run", "--ids", "38,61", "--limit", "5", "--sync", "--data-dir", "/tmp/d", "--out-dir", "/tmp/o")
      assert.deepStrictEqual([...Option.getOrElse(options.ids, () => new Set())], [38, 61])
      assert.deepStrictEqual(options.limit, Option.some(5))
      assert.isTrue(options.sync)
      assert.strictEqual(options.dataDir, "/tmp/d")
      assert.strictEqual(options.outDir, "/tmp/o")
    })

    it("keeps the rule that --retry-failed does not go with --ids or --limit", () => {
      assert.isTrue(dry("--dry-run", "--retry-failed").retryFailed)
      assert.include(failure("--dry-run", "--retry-failed", "--ids", "5"), "--retry-failed")
    })

    it("is not a dry run without the flag", () => {
      assert.strictEqual(run("--limit", "5").model, "claude-haiku-5-5")
    })
  })

  it("describes every option in the usage text", () => {
    for (const flag of ["--model", "--ids", "--limit", "--sync", "--retry-failed", "--data-dir", "--out-dir", "--dry-run", "--help"]) {
      assert.include(USAGE, flag)
    }
    assert.include(USAGE, "ANTHROPIC_API_KEY")
  })
})

describe("parseEvalCli", () => {
  const options = (...argv: ReadonlyArray<string>) => {
    const result = parseEvalCli(argv)
    if (Result.isFailure(result) || result.success._tag !== "Run") {
      return assert.fail("expected a run command")
    }
    return result.success.options
  }

  it("uses the defaults", () => {
    assert.deepStrictEqual(options(), { dataDir: "data", outDir: "data/enriched", goldFile: DEFAULT_GOLD_FILE })
    assert.match(DEFAULT_GOLD_FILE, /test\/fixtures\/gold\.json$/)
  })

  it("reads the options", () => {
    assert.deepStrictEqual(options("--out-dir", "o", "--data-dir", "d", "--gold", "g.json"), {
      dataDir: "d",
      outDir: "o",
      goldFile: "g.json"
    })
  })

  it("rejects an unknown option and an empty value", () => {
    assert.isTrue(Result.isFailure(parseEvalCli(["--model", "x"])))
    assert.isTrue(Result.isFailure(parseEvalCli(["--out-dir", ""])))
  })

  it("asks for help", () => {
    assert.isTrue(Result.isSuccess(parseEvalCli(["-h"])))
  })
})
