import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { GoldJson } from "../src/domain/gold.ts"
import { parseEnrichCli, USAGE } from "../src/enrich/cli-options.ts"
import { EVAL_USAGE, parseEvalCli } from "../src/enrich/eval-cli-options.ts"

/** The README is the only guide of the user. These tests keep its commands true. */

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
const gold = Schema.decodeUnknownSync(GoldJson)(readFileSync(new URL("./fixtures/gold.json", import.meta.url), "utf8"))

const start = readme.indexOf("\n## Enrichment")
const end = readme.indexOf("\n## Development")
const section = start >= 0 && end > start ? readme.slice(start, end) : ""

/** The lines of the section that start with `npm run enrich`, as the arguments after `--`. */
const commands = (script: "enrich" | "enrich:eval"): ReadonlyArray<ReadonlyArray<string>> =>
  section.split("\n").flatMap((line) => {
    const text = line.trim()
    const prefix = `npm run ${script} -- `
    return text.startsWith(prefix) ? [text.slice(prefix.length).split(/\s+/)] : []
  })

const flagsOf = (usage: string): ReadonlyArray<string> =>
  [...new Set(usage.match(/--[a-z][a-z-]*/g) ?? [])]

describe("README section Enrichment", () => {
  it("exists", () => {
    assert.isAbove(section.length, 1000)
  })

  it("tells how to set the key in the environment and in .env", () => {
    assert.include(section, "export ANTHROPIC_API_KEY=")
    assert.include(section, "`.env`")
  })

  it("has the commands of the task: dry run, 2 pilot runs, 2 evaluations, full run and retry", () => {
    const enrich = commands("enrich").map((args) => args.join(" "))
    const goldIds = gold.map((entry) => entry.id).join(",")
    assert.include(enrich, "--dry-run")
    assert.include(enrich, `--model claude-haiku-5-5 --sync --out-dir data/eval/haiku --ids ${goldIds}`)
    assert.include(enrich, `--model claude-sonnet-5-5 --sync --out-dir data/eval/sonnet --ids ${goldIds}`)
    assert.include(enrich, "--model claude-haiku-5-5")
    assert.include(enrich, "--model claude-haiku-5-5 --retry-failed")
    const evaluation = commands("enrich:eval").map((args) => args.join(" "))
    assert.deepStrictEqual(evaluation, ["--out-dir data/eval/haiku", "--out-dir data/eval/sonnet"])
  })

  it("has commands that the parser of the flags accepts", () => {
    for (const args of commands("enrich")) {
      const result = parseEnrichCli(args)
      assert.isTrue(Result.isSuccess(result), `npm run enrich -- ${args.join(" ")}`)
    }
    for (const args of commands("enrich:eval")) {
      const result = parseEvalCli(args)
      assert.isTrue(Result.isSuccess(result), `npm run enrich:eval -- ${args.join(" ")}`)
    }
  })

  it("describes every flag of npm run enrich and of npm run enrich:eval", () => {
    for (const flag of [...flagsOf(USAGE), ...flagsOf(EVAL_USAGE)]) {
      assert.include(section, `\`${flag}`, flag)
    }
  })
})
