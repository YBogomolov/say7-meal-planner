import { assert, describe, it } from "@effect/vitest"
import { buildMessageParams } from "../src/enrich/api.ts"
import { ENRICHMENT_JSON_SCHEMA } from "../src/enrich/json-schema.ts"
import { SYSTEM_PROMPT } from "../src/enrich/prompt.ts"
import {
  A4_FORBIDDEN_KEYWORDS,
  A4_MAX_OPTIONAL_PROPERTIES,
  A4_MAX_UNION_PROPERTIES,
  walkA4
} from "./support/api-schema.ts"
import { must } from "./support/enrich.ts"

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...extra
})

/** The walker itself: it must fail on what spec A4 forbids, or the test of the real schema proves nothing. */
describe("walkA4 (the check of this test file)", () => {
  it("accepts a schema inside the subset", () => {
    const schema = object({
      a: { type: "string", enum: ["x", "y"] },
      b: { type: ["number", "null"] },
      c: { type: "array", items: object({ d: { type: "integer" } }), minItems: 1 },
      e: { type: "array", items: { type: "string" }, minItems: 0 }
    })
    assert.deepStrictEqual(walkA4(schema).problems, [])
    assert.deepStrictEqual(
      { objects: walkA4(schema).objects, unions: walkA4(schema).unionProperties },
      { objects: 2, unions: 1 }
    )
  })

  it.each(A4_FORBIDDEN_KEYWORDS.map((keyword) => [keyword]))("fails on the keyword %s", (keyword) => {
    const walk = walkA4(object({ a: { type: "integer", [keyword]: 1 } }))
    assert.deepStrictEqual(walk.problems, [`$.a: forbidden keyword ${keyword}`])
  })

  it("fails on a keyword in an array item and in an anyOf branch", () => {
    assert.lengthOf(walkA4(object({ a: { type: "array", items: { type: "string", maxLength: 3 } } })).problems, 1)
    assert.lengthOf(walkA4(object({ a: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] } })).problems, 1)
  })

  it("fails on minItems above 1", () => {
    const walk = walkA4(object({ a: { type: "array", items: { type: "string" }, minItems: 2 } }))
    assert.deepStrictEqual(walk.problems, ["$.a: minItems must be 0 or 1"])
  })

  it("fails on an object without additionalProperties false, at any depth", () => {
    const open = { type: "object", required: ["z"], properties: { z: { type: "string" } } }
    assert.deepStrictEqual(walkA4(open).problems, ["$: additionalProperties is not false"])
    assert.deepStrictEqual(walkA4(object({ a: open })).problems, ["$.a: additionalProperties is not false"])
    assert.deepStrictEqual(walkA4(object({ a: { type: "array", items: open } })).problems, [
      "$.a[]: additionalProperties is not false"
    ])
    assert.deepStrictEqual(walkA4({ ...open, additionalProperties: true }).problems, [
      "$: additionalProperties is not false"
    ])
  })

  it("fails on more than 24 optional properties, and accepts 24", () => {
    const optional = (count: number) =>
      object(Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, { type: "string" }])), { required: [] })
    assert.deepStrictEqual(walkA4(optional(A4_MAX_OPTIONAL_PROPERTIES)).problems, [])
    assert.deepStrictEqual(walkA4(optional(A4_MAX_OPTIONAL_PROPERTIES + 1)).problems, [
      "25 optional properties; the limit is 24"
    ])
  })

  it("fails on more than 16 properties with anyOf or a type array, and accepts 16", () => {
    const unions = (count: number) =>
      object(
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `p${i}`,
            i % 2 === 0 ? { type: ["string", "null"] } : { anyOf: [{ type: "string" }, { type: "null" }] }
          ])
        )
      )
    assert.deepStrictEqual(walkA4(unions(A4_MAX_UNION_PROPERTIES)).problems, [])
    assert.deepStrictEqual(walkA4(unions(A4_MAX_UNION_PROPERTIES + 1)).problems, [
      "17 properties with anyOf or a type array; the limit is 16"
    ])
  })

  it("counts a property that is missing from required as optional", () => {
    const walk = walkA4(object({ a: { type: "string" }, b: { type: "string" } }, { required: ["a"] }))
    assert.strictEqual(walk.optionalProperties, 1)
  })
})

describe("the JSON Schema that goes to the API obeys spec A4", () => {
  const params = buildMessageParams({
    model: "claude-haiku-5-5",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: "{}" }],
    maxTokens: 100
  })
  const sent = params.output_config?.format?.schema

  it("is the schema of output_config.format in the request", () => {
    assert.deepStrictEqual(sent, ENRICHMENT_JSON_SCHEMA)
  })

  it("has no forbidden keyword, and every object has additionalProperties false", () => {
    assert.deepStrictEqual(walkA4(sent).problems, [])
  })

  it("has no optional property: all properties are required, and no value is null", () => {
    const walk = walkA4(sent)
    assert.strictEqual(walk.optionalProperties, 0)
    assert.isAtMost(walk.optionalProperties, A4_MAX_OPTIONAL_PROPERTIES)
  })

  it("has at most 16 properties with anyOf or a type array", () => {
    const walk = walkA4(sent)
    assert.isAtMost(walk.unionProperties, A4_MAX_UNION_PROPERTIES)
    // sideHint, longWaitHours, and detail, quantity, unit, grams of an ingredient
    assert.strictEqual(walk.unionProperties, 6)
  })

  it("has the 3 objects of the answer: the answer, the ingredient and the servings", () => {
    const walk = walkA4(sent)
    assert.strictEqual(walk.objects, 3)
    assert.strictEqual(walk.properties, 16 + 9 + 3)
  })

  it("survives the JSON text that the SDK sends, without a change", () => {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(must(sent, "schema"))), sent)
  })
})
