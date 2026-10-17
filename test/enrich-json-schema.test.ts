import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import {
  checkApiSchema,
  ENRICHMENT_CODEC,
  ENRICHMENT_JSON_SCHEMA,
  MAX_NULLABLE_PROPERTIES,
  MAX_OPTIONAL_PROPERTIES,
} from "../src/enrich/json-schema.ts"
import { EXAMPLE_OUTPUT } from "../src/enrich/prompt.ts"
import { walkA4 } from "./support/api-schema.ts"

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...extra,
})

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The child of a schema node by key, or `{}` when it is missing (a test then fails on the assertion). */
const child = (node: unknown, key: string): Readonly<Record<string, unknown>> => {
  const value = isRecord(node) ? node[key] : undefined
  return isRecord(value) ? value : {}
}

const propertyNames = (node: unknown): ReadonlyArray<string> => Object.keys(child(node, "properties"))

/** Every object node of a schema with its path. */
const objectNodes = (schema: unknown): ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> => {
  const found: Array<readonly [string, Readonly<Record<string, unknown>>]> = []
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
    } else if (isRecord(node)) {
      if ("properties" in node) found.push([path, node])
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
    }
  }
  walk(schema, "$")
  return found
}

const ingredientNode = child(child(child(ENRICHMENT_JSON_SCHEMA, "properties"), "ingredients"), "items")

describe("the JSON Schema for output_config.format (generated from the Effect Schema)", () => {
  const check = checkApiSchema(ENRICHMENT_JSON_SCHEMA)

  it("has none of the features that the API does not support (spec A4)", () => {
    assert.deepStrictEqual(check.violations, [])
    assert.deepStrictEqual(walkA4(ENRICHMENT_JSON_SCHEMA).problems, [])
  })

  it("has no $defs and no $ref", () => {
    const text = JSON.stringify(ENRICHMENT_JSON_SCHEMA)
    assert.notInclude(text, "$ref")
    assert.notInclude(text, "$defs")
  })

  it("has no minimum, maximum, minLength or maxLength anywhere", () => {
    const text = JSON.stringify(ENRICHMENT_JSON_SCHEMA)
    for (const keyword of ["minimum", "maximum", "minLength", "maxLength"]) {
      assert.notInclude(text, `"${keyword}"`)
    }
  })

  it("has additionalProperties false and required equal to the property names in every object", () => {
    const objects = objectNodes(ENRICHMENT_JSON_SCHEMA)
    assert.strictEqual(objects.length, 3)
    for (const [path, node] of objects) {
      assert.strictEqual(node["additionalProperties"], false, path)
      assert.deepStrictEqual(
        [...(Array.isArray(node["required"]) ? node["required"] : [])].toSorted(),
        [...propertyNames(node)].toSorted(),
        path
      )
    }
  })

  it("has at most 16 properties with anyOf or a type array", () => {
    assert.isAtMost(check.nullableProperties, MAX_NULLABLE_PROPERTIES)
    // sideHint, longWaitHours, and detail, quantity, unit, grams of an ingredient
    assert.strictEqual(check.nullableProperties, 6)
  })

  it("has no optional property", () => {
    assert.strictEqual(check.optionalProperties, 0)
    assert.isAtMost(check.optionalProperties, MAX_OPTIONAL_PROPERTIES)
  })

  it("keeps the field order of the model: ingredients first", () => {
    assert.deepStrictEqual(propertyNames(ENRICHMENT_JSON_SCHEMA), [
      "ingredients",
      "proteinFamilies",
      "vegetarian",
      "dishType",
      "mealFit",
      "sideHint",
      "servings",
      "activeMinutes",
      "totalMinutes",
      "longWaitHours",
      "heat",
      "difficulty",
      "equipment",
      "fridgeDays",
      "freezable",
      "reheats",
    ])
    assert.deepStrictEqual(propertyNames(ingredientNode), [
      "line",
      "item",
      "detail",
      "category",
      "pantry",
      "quantity",
      "unit",
      "grams",
      "optional",
    ])
  })

  it("writes the nullable unit as anyOf with a typed enum and a null branch, not as enum with a type array", () => {
    const unit = child(child(ingredientNode, "properties"), "unit")
    assert.deepStrictEqual(unit, {
      anyOf: [
        {
          type: "string",
          enum: ["g", "ml", "pcs", "tbsp", "tsp", "pinch", "bunch", "clove", "slice", "pack"],
        },
        { type: "null" },
      ],
    })
  })

  it("gives every node with enum or const a single type", () => {
    const offenders: Array<string> = []
    const find = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => find(item, `${path}[${index}]`))
      } else if (isRecord(node)) {
        if (("enum" in node || "const" in node) && typeof node["type"] !== "string") offenders.push(path)
        for (const [key, value] of Object.entries(node)) find(value, `${path}.${key}`)
      }
    }
    find(ENRICHMENT_JSON_SCHEMA, "$")
    assert.deepStrictEqual(offenders, [])
  })

  it("keeps the numeric values of heat and difficulty", () => {
    const properties = child(ENRICHMENT_JSON_SCHEMA, "properties")
    assert.deepStrictEqual(child(properties, "heat")["enum"], [0, 1, 2, 3])
    assert.deepStrictEqual(child(properties, "difficulty")["enum"], [1, 2, 3])
  })
})

describe("the codec of the generated schema", () => {
  const decode = Schema.decodeUnknownResult(ENRICHMENT_CODEC)

  it("decodes a valid answer", () => {
    assert.deepStrictEqual(Result.getOrUndefined(decode(JSON.parse(JSON.stringify(EXAMPLE_OUTPUT)))), EXAMPLE_OUTPUT)
  })

  it("still checks the ranges that the API schema does not have", () => {
    assert.isTrue(Result.isFailure(decode({ ...EXAMPLE_OUTPUT, fridgeDays: 5 })))
    assert.isTrue(Result.isFailure(decode({ ...EXAMPLE_OUTPUT, activeMinutes: -1 })))
    assert.isTrue(Result.isFailure(decode({ ...EXAMPLE_OUTPUT, servings: { min: 4, max: 2, source: "page" } })))
  })
})

describe("checkApiSchema", () => {
  const violationsOf = (schema: unknown): ReadonlyArray<string> => checkApiSchema(schema).violations

  it("accepts a small valid schema", () => {
    assert.deepStrictEqual(
      violationsOf(
        object({
          a: { type: "string", enum: ["x", "y"] },
          b: { type: ["number", "null"] },
        })
      ),
      []
    )
  })

  it.each([
    ["minimum", { type: "integer", minimum: 0 }],
    ["maximum", { type: "integer", maximum: 4 }],
    ["exclusiveMinimum", { type: "number", exclusiveMinimum: 0 }],
    ["multipleOf", { type: "number", multipleOf: 5 }],
    ["minLength", { type: "string", minLength: 1 }],
    ["maxLength", { type: "string", maxLength: 10 }],
    ["maxItems", { type: "array", items: { type: "string" }, maxItems: 3 }],
    ["uniqueItems", { type: "array", items: { type: "string" }, uniqueItems: true }],
    ["oneOf", { oneOf: [{ type: "string" }, { type: "null" }] }],
    ["$ref", { $ref: "#/$defs/x" }],
    ["format as an unknown keyword", { type: "string", format: "date" }],
  ])("rejects %s", (name, property) => {
    const violations = violationsOf(object({ a: property }))
    assert.isTrue(
      violations.some((text) => text.includes(`"${name.split(" ")[0]}"`)),
      violations.join("; ")
    )
  })

  it("rejects enum or const together with a type array (the API answers HTTP 400)", () => {
    assert.deepStrictEqual(violationsOf(object({ a: { type: ["string", "null"], enum: ["a", null] } })), [
      '$.a: "enum" must not be combined with a type array; use "anyOf" with a typed branch that has "enum" and a branch {"type":"null"}',
    ])
    assert.deepStrictEqual(violationsOf(object({ a: { type: ["string", "null"], const: "a" } })), [
      '$.a: "const" must not be combined with a type array; use "anyOf" with a typed branch that has "const" and a branch {"type":"null"}',
    ])
    assert.lengthOf(
      violationsOf(
        object({
          list: {
            type: "array",
            items: { type: ["string", "null"], enum: ["a", null] },
          },
        })
      ),
      1
    )
    assert.lengthOf(
      violationsOf(
        object({
          either: { anyOf: [{ type: ["string", "null"], enum: ["a", null] }] },
        })
      ),
      1
    )
  })

  it("accepts a nullable enum in the anyOf form and a type array without enum, and counts each as 1 nullable property", () => {
    const nullableEnum = {
      anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }],
    }
    const result = checkApiSchema(
      object({
        a: nullableEnum,
        b: { type: ["number", "null"] },
        c: { type: "string", enum: ["x"] },
      })
    )
    assert.deepStrictEqual(result.violations, [])
    assert.strictEqual(result.nullableProperties, 2)
    assert.strictEqual(result.optionalProperties, 0)
    assert.strictEqual(result.properties, 3)
    assert.strictEqual(result.objects, 1)
  })

  it("rejects minItems above 1 and accepts 0 and 1", () => {
    const array = (minItems: number) => ({
      type: "array",
      items: { type: "string" },
      minItems,
    })
    assert.deepStrictEqual(violationsOf(object({ a: array(0), b: array(1) })), [])
    assert.deepStrictEqual(violationsOf(object({ a: array(2) })), ['$.a: "minItems" must be 0 or 1'])
  })

  it("rejects a pattern with look-around or a back reference", () => {
    for (const pattern of ["^(?=a)b", "(?!a)b", "(?<=a)b", "(?<!a)b", "(a)\\1"]) {
      assert.lengthOf(violationsOf(object({ a: { type: "string", pattern } })), 1, pattern)
    }
    assert.deepStrictEqual(violationsOf(object({ a: { type: "string", pattern: "^[a-z]+$" } })), [])
  })

  it("rejects an object without additionalProperties false", () => {
    const loose = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    }
    assert.deepStrictEqual(violationsOf(loose), ['$: an object needs "additionalProperties": false'])
    assert.deepStrictEqual(violationsOf(object({ inner: loose })), [
      '$.inner: an object needs "additionalProperties": false',
    ])
    assert.lengthOf(violationsOf({ ...loose, additionalProperties: true }), 1)
  })

  it("rejects an object inside an array and inside anyOf when it is open", () => {
    const loose = { type: "object", required: [], properties: {} }
    assert.lengthOf(violationsOf(object({ list: { type: "array", items: loose } })), 1)
    assert.lengthOf(violationsOf(object({ either: { anyOf: [loose, { type: "null" }] } })), 1)
  })

  it("rejects an optional property", () => {
    const schema = {
      ...object({ a: { type: "string" }, b: { type: "string" } }),
      required: ["a"],
    }
    const result = checkApiSchema(schema)
    assert.strictEqual(result.optionalProperties, 1)
    assert.isTrue(result.violations.some((text) => text.startsWith("$.b: the property is optional")))
  })

  it("rejects a required name that is not a property", () => {
    const schema = {
      ...object({ a: { type: "string" } }),
      required: ["a", "z"],
    }
    assert.deepStrictEqual(violationsOf(schema), ['$: "required" names the unknown property "z"'])
  })

  it("counts the properties with anyOf or a type array, and rejects more than 16", () => {
    const nullable = (count: number) =>
      object(
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `p${i}`,
            i % 2 === 0 ? { type: ["string", "null"] } : { anyOf: [{ type: "string" }, { type: "null" }] },
          ])
        )
      )
    assert.strictEqual(checkApiSchema(nullable(16)).nullableProperties, 16)
    assert.deepStrictEqual(violationsOf(nullable(16)), [])
    assert.deepStrictEqual(violationsOf(nullable(17)), ["17 properties use anyOf or a type array; the limit is 16"])
  })

  it("rejects more than 24 optional properties", () => {
    const properties = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: "string" }]))
    const result = checkApiSchema({ ...object(properties), required: [] })
    assert.strictEqual(result.optionalProperties, 25)
    assert.isTrue(result.violations.includes("25 optional properties; the limit is 24"))
  })

  it("rejects a root that is not an object", () => {
    assert.isTrue(violationsOf({ type: "array", items: { type: "string" } }).some((text) => text.includes("root")))
    assert.isTrue(violationsOf("x").length > 0)
  })
})
