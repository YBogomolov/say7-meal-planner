import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { checkLineRange, Enrichment } from "../src/domain/enriched-recipe.ts"
import { GoldJson } from "../src/domain/gold.ts"
import { allLines, lineCount, modelInputText } from "../src/enrich/input.ts"
import { ENRICHMENT_JSON_SCHEMA } from "../src/enrich/json-schema.ts"
import { EXAMPLE_INPUT, EXAMPLE_OUTPUT, PROMPT_VERSION, retryMessage, SYSTEM_PROMPT } from "../src/enrich/prompt.ts"

/**
 * The fingerprint of the system prompt and the JSON Schema for PROMPT_VERSION 1.
 * If this test fails: change PROMPT_VERSION in src/enrich/prompt.ts, then copy the new value here.
 * A new version makes every stored file stale (spec A8), which is the intent.
 */
const FINGERPRINTS: Readonly<Record<number, string>> = {
  1: "20b2176f355b1321c2f6c129818044ff01083d1f1da60393c940c75c9e1c4f8b"
}

describe("PROMPT_VERSION", () => {
  it("is pinned to the text of the prompt and the output schema", () => {
    const fingerprint = createHash("sha256")
      .update(`${SYSTEM_PROMPT}\n${JSON.stringify(ENRICHMENT_JSON_SCHEMA)}`)
      .digest("hex")
    assert.strictEqual(
      fingerprint,
      FINGERPRINTS[PROMPT_VERSION],
      `The prompt or the schema changed. Increase PROMPT_VERSION and add this fingerprint to the test: ${fingerprint}`
    )
  })

  it("is a whole number from 1", () => {
    assert.isTrue(Number.isInteger(PROMPT_VERSION) && PROMPT_VERSION >= 1)
  })
})

describe("the worked example", () => {
  it("has an answer that the Effect Schema accepts", () => {
    assert.isTrue(Result.isSuccess(Schema.decodeUnknownResult(Enrichment)(EXAMPLE_OUTPUT)))
  })

  it("has an answer with only lines of the example input", () => {
    assert.deepStrictEqual(checkLineRange(EXAMPLE_OUTPUT, lineCount(EXAMPLE_INPUT)), [])
  })

  it("has at least 1 item for each line, and 2 items for the line with 2 products", () => {
    const counts = allLines(EXAMPLE_INPUT).map((line) => EXAMPLE_OUTPUT.ingredients.filter((item) => item.line === line.line).length)
    assert.isTrue(counts.every((count) => count >= 1))
    assert.strictEqual(counts[7], 2)
  })

  it("is part of the system prompt, with the same input text that the run sends", () => {
    assert.include(SYSTEM_PROMPT, modelInputText(EXAMPLE_INPUT))
    assert.include(SYSTEM_PROMPT, JSON.stringify(EXAMPLE_OUTPUT))
  })

  it("is not a page of the site: it has no gold recipe", () => {
    const gold = Schema.decodeUnknownSync(GoldJson)(readFileSync(new URL("./fixtures/gold.json", import.meta.url), "utf8"))
    for (const entry of gold) {
      assert.notInclude(SYSTEM_PROMPT, entry.title)
    }
  })
})

describe("SYSTEM_PROMPT", () => {
  it("does not contain a long line of the gold set", () => {
    // A short line such as "мука" is a common word and can appear in the rules.
    const gold = Schema.decodeUnknownSync(GoldJson)(readFileSync(new URL("./fixtures/gold.json", import.meta.url), "utf8"))
    const lines = gold.flatMap((entry) => entry.keyLines.map((line) => line.raw)).filter((raw) => raw.length >= 10)
    assert.isAbove(lines.length, 10)
    for (const raw of lines) {
      assert.notInclude(SYSTEM_PROMPT, raw)
    }
  })

  it("lists the equipment of the household (spec section 2, H7)", () => {
    for (const word of ["hob", "oven", "microwave", "air fryer", "food processor", "immersion blender", "side-by-side fridge"]) {
      assert.include(SYSTEM_PROMPT, word)
    }
  })

  it("defines the pantry", () => {
    assert.include(SYSTEM_PROMPT, "pantry")
    for (const word of ["salt", "pepper", "sugar", "flour", "oil", "vinegar", "baking powder", "soda", "water"]) {
      assert.include(SYSTEM_PROMPT, word)
    }
  })

  it("gives the rules for the names of the products", () => {
    assert.include(SYSTEM_PROMPT, "nominative case, lower case")
    assert.include(SYSTEM_PROMPT, "A line with 2 products")
  })

  it("lets servings.source be page only for a stated number", () => {
    assert.include(SYSTEM_PROMPT, 'source is "page" only if the page states')
  })

  it("tells the model to judge the heat from the real ingredients", () => {
    assert.include(SYSTEM_PROMPT, "heat: judge from the real ingredients")
  })

  it("names every field of the answer", () => {
    for (const name of Object.keys(ENRICHMENT_JSON_SCHEMA.properties)) {
      assert.include(SYSTEM_PROMPT, name)
    }
  })

  it("names every value of the enums", () => {
    const text = JSON.stringify(ENRICHMENT_JSON_SCHEMA.properties)
    const values = [...text.matchAll(/"enum":\[([^\]]*)\]/g)].flatMap((match) =>
      (match[1] ?? "").split(",").map((value) => value.replaceAll('"', "")).filter((value) => /^[a-z_]+$/.test(value))
    )
    assert.isAbove(values.length, 40)
    for (const value of new Set(values)) {
      assert.include(SYSTEM_PROMPT, value)
    }
  })

  it("is longer than 4 096 characters, so that the prompt cache has a chance to apply", () => {
    assert.isAbove(SYSTEM_PROMPT.length, 4096)
  })
})

describe("retryMessage", () => {
  it("has the problem and the instruction to answer again", () => {
    const text = retryMessage("heat: expected 0..3")
    assert.include(text, "heat: expected 0..3")
    assert.include(text, "Answer again")
  })

  it("cuts a long problem", () => {
    const text = retryMessage("x".repeat(10_000))
    assert.isBelow(text.length, 1800)
  })
})
