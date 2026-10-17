import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Enrichment } from "../src/domain/enriched-recipe.ts"
import {
  checkApiSchema,
  ENRICHMENT_JSON_SCHEMA,
  MAX_NULLABLE_PROPERTIES,
  MAX_OPTIONAL_PROPERTIES,
} from "../src/enrich/json-schema.ts"

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...extra,
})

describe("the JSON Schema for output_config.format", () => {
  const check = checkApiSchema(ENRICHMENT_JSON_SCHEMA)

  it("has none of the features that the API does not support (spec A4)", () => {
    assert.deepStrictEqual(check.violations, [])
  })

  it("has at most 16 properties with anyOf or a type array", () => {
    assert.isAtMost(check.nullableProperties, MAX_NULLABLE_PROPERTIES)
    // sideHint, longWaitHours, and detail, quantity, unit, grams of an ingredient
    assert.strictEqual(check.nullableProperties, 6)
  })

  it("writes the nullable unit as anyOf with a typed enum and a null branch, not as enum with a type array", () => {
    const unit = ENRICHMENT_JSON_SCHEMA.properties.ingredients.items.properties.unit
    assert.deepStrictEqual(unit, {
      anyOf: [
        {
          type: "string",
          enum: ["g", "ml", "pcs", "tbsp", "tsp", "pinch", "bunch", "clove", "slice", "pack"],
        },
        { type: "null" },
      ],
    })
    assert.deepStrictEqual(JSON.parse(JSON.stringify(unit)), unit)
  })

  it("has no node with enum or const together with a type array", () => {
    const offenders: Array<string> = []
    const find = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => find(child, `${path}[${index}]`))
      } else if (isRecord(node)) {
        if (Array.isArray(node["type"]) && ("enum" in node || "const" in node)) {
          offenders.push(path)
        }
        for (const [key, child] of Object.entries(node)) find(child, `${path}.${key}`)
      }
    }
    find(ENRICHMENT_JSON_SCHEMA, "$")
    assert.deepStrictEqual(offenders, [])
  })

  it("has no optional property", () => {
    assert.strictEqual(check.optionalProperties, 0)
    assert.isAtMost(check.optionalProperties, MAX_OPTIONAL_PROPERTIES)
  })

  it("counts 17 top-level fields and 9 item fields in 3 objects", () => {
    assert.strictEqual(check.objects, 3)
    assert.strictEqual(check.properties, 16 + 9 + 3)
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

/** Property names and enum values of a JSON Schema, by path. `anyOf` branches merge and `null` does not count. */
interface Shape {
  readonly properties: Map<string, ReadonlyArray<string>>
  readonly enums: Map<string, ReadonlyArray<string>>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const shapeOf = (schema: unknown): Shape => {
  const shape: Shape = { properties: new Map(), enums: new Map() }
  const walk = (node: unknown, path: string): void => {
    if (!isRecord(node)) return
    if (Array.isArray(node["enum"])) {
      const values = node["enum"].filter((value) => value !== null).map((value) => JSON.stringify(value))
      shape.enums.set(path, [...(shape.enums.get(path) ?? []), ...values].toSorted())
    }
    if (isRecord(node["properties"])) {
      shape.properties.set(path, Object.keys(node["properties"]).toSorted())
      for (const [name, child] of Object.entries(node["properties"])) walk(child, `${path}.${name}`)
    }
    if ("items" in node) walk(node["items"], `${path}[]`)
    if (Array.isArray(node["anyOf"])) for (const branch of node["anyOf"]) walk(branch, path)
    if (Array.isArray(node["oneOf"])) for (const branch of node["oneOf"]) walk(branch, path)
    if ("const" in node) {
      shape.enums.set(path, [...(shape.enums.get(path) ?? []), JSON.stringify(node["const"])].toSorted())
    }
  }
  walk(schema, "$")
  return shape
}

describe("the Effect Schema and the JSON Schema agree", () => {
  const effect = shapeOf(Schema.toJsonSchemaDocument(Enrichment).schema)
  const api = shapeOf(ENRICHMENT_JSON_SCHEMA)

  it("have the same field names in every object", () => {
    assert.deepStrictEqual([...api.properties.keys()].toSorted(), [...effect.properties.keys()].toSorted())
    for (const [path, names] of effect.properties) {
      assert.deepStrictEqual(api.properties.get(path), names, path)
    }
  })

  it("have the same enum values in every field", () => {
    assert.deepStrictEqual([...api.enums.keys()].toSorted(), [...effect.enums.keys()].toSorted())
    for (const [path, values] of effect.enums) {
      assert.deepStrictEqual(api.enums.get(path), values, path)
    }
  })

  it("cover the 16 fields of the table P3.4 and the 9 fields of an ingredient", () => {
    assert.deepStrictEqual(effect.properties.get("$")?.length, 16)
    assert.deepStrictEqual(effect.properties.get("$.ingredients[]")?.length, 9)
    assert.deepStrictEqual(api.properties.get("$.servings"), ["max", "min", "source"])
  })
})
