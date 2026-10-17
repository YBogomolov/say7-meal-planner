import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { GoldJson } from "../src/domain/gold.ts"
import { makeEnrichCommand } from "../src/enrich/cli-options.ts"
import type { EnrichCliCommand } from "../src/enrich/cli-options.ts"
import { makeEvalCommand } from "../src/enrich/eval-cli-options.ts"
import type { EvalCliOptions } from "../src/enrich/eval-cli-options.ts"
import { commandTester } from "./support/cli.ts"

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

const enrich = commandTester<EnrichCliCommand>()(makeEnrichCommand)
const evaluation = commandTester<EvalCliOptions>()(makeEvalCommand)

/** The flags that effect/cli adds to every command. */
const GLOBAL_FLAGS = ["--help", "--version", "--wizard", "--completions", "--log-level"]

const flagsOf = (usage: string): ReadonlyArray<string> => [...new Set(usage.match(/--[a-z][a-z-]*/g) ?? [])]

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

  it.effect("has commands that the commands of the scripts accept", () =>
    Effect.gen(function* () {
      for (const args of commands("enrich")) {
        yield* enrich.parsed(args)
      }
      for (const args of commands("enrich:eval")) {
        yield* evaluation.parsed(args)
      }
    })
  )

  it.effect("describes every flag of npm run enrich and of npm run enrich:eval", () =>
    Effect.gen(function* () {
      const help = [yield* enrich.help(), yield* evaluation.help()]
      for (const flag of help.flatMap((text) => flagsOf(text))) {
        if (!GLOBAL_FLAGS.includes(flag)) {
          assert.include(section, `\`${flag}`, flag)
        }
      }
    })
  )
})
