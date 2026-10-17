import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput"
import { Enrichment } from "../domain/enriched-recipe.ts"

/**
 * The JSON Schema that the API gets in `output_config.format` (spec A3, A4), and the codec for the answer.
 *
 * Both come from the Effect Schema `Enrichment` (src/domain/enriched-recipe.ts) through `toCodecAnthropic`.
 * The schema is that output after `normalizeApiSchema`, byte for byte the schema of PROMPT_VERSION 2.
 * It obeys spec A4: every object has `additionalProperties: false`, all properties are required, "no value" is `null`,
 * and there is no `minimum`, `maximum`, `minLength` or `maxLength`. The ranges stay in the codec.
 * The order of `properties` is the field order of `Enrichment`: the ingredients come first.
 */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

type Json = Readonly<Record<string, unknown>>

const isNullBranch = (node: unknown): boolean =>
  isRecord(node) && node["type"] === "null" && Object.keys(node).length === 1

/**
 * Bring the generated schema to the exact shape (and bytes) that the prompt version pins:
 * - `description` is dropped (it only repeats the checks of the codec);
 * - an enum of integers has `type: "integer"` (the generator writes `number`);
 * - a plain nullable scalar is `{"type": [x, "null"]}`; a nullable enum stays `anyOf`;
 * - an object has the key order `type`, `additionalProperties`, `required`, `properties`.
 * The function is pure and walks only the keywords that the schema uses.
 */
export const normalizeApiSchema = (node: unknown): unknown => {
  if (!isRecord(node)) return node
  const { description: _description, ...rest } = node
  const anyOf = rest["anyOf"]
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const [value, none] = anyOf.map(normalizeApiSchema)
    if (isNullBranch(none) && isRecord(value) && Object.keys(value).length === 1 && typeof value["type"] === "string") {
      return { type: [value["type"], "null"] }
    }
    return { anyOf: anyOf.map(normalizeApiSchema) }
  }
  const properties = rest["properties"]
  if (isRecord(properties)) {
    return {
      type: rest["type"],
      additionalProperties: rest["additionalProperties"],
      required: rest["required"],
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, child]) => [key, normalizeApiSchema(child)])
      ),
    }
  }
  const values = rest["enum"]
  const type =
    rest["type"] === "number" && Array.isArray(values) && values.every((value) => Number.isInteger(value))
      ? "integer"
      : rest["type"]
  return {
    ...rest,
    type,
    ...("items" in rest ? { items: normalizeApiSchema(rest["items"]) } : {}),
  }
}

const generated = toCodecAnthropic(Enrichment)

export const ENRICHMENT_JSON_SCHEMA: Json = (() => {
  const normalized = normalizeApiSchema(generated.jsonSchema)
  return isRecord(normalized) ? normalized : generated.jsonSchema
})()

/** Decodes the parsed JSON of the model answer into `Enrichment`, with all range checks. */
export const ENRICHMENT_CODEC = generated.codec

/** Limits of spec A4. */
export const MAX_NULLABLE_PROPERTIES = 16
export const MAX_OPTIONAL_PROPERTIES = 24

/** Keywords that this project may use in the schema. The API supports a subset of JSON Schema. */
const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "minItems",
  "pattern",
  "description",
  "title",
])

/** Keywords that the API rejects or ignores, with the reason for the message. */
const UNSUPPORTED_KEYWORDS: Readonly<Record<string, string>> = {
  minimum: "numeric bounds are not supported",
  maximum: "numeric bounds are not supported",
  exclusiveMinimum: "numeric bounds are not supported",
  exclusiveMaximum: "numeric bounds are not supported",
  multipleOf: "numeric bounds are not supported",
  minLength: "string length bounds are not supported",
  maxLength: "string length bounds are not supported",
  maxItems: "only minItems 0 or 1 is supported",
  uniqueItems: "array constraints are not supported",
  minProperties: "object size bounds are not supported",
  maxProperties: "object size bounds are not supported",
  patternProperties: "not supported",
  oneOf: "use anyOf",
  allOf: "not used in this project",
  not: "not supported",
  $ref: "not used in this project (no recursion is allowed)",
  $defs: "not used in this project",
}

/** A regular expression with a look-around or a back reference does not work in the API. */
const UNSUPPORTED_PATTERN = /\(\?<?[=!]|\\[1-9]|\\k</

export interface ApiSchemaCheck {
  /** Every reason why the API would reject the schema. Empty when the schema is valid. */
  readonly violations: ReadonlyArray<string>
  /** Number of properties that use `anyOf` or a type array. */
  readonly nullableProperties: number
  /** Number of properties that are not in `required`. */
  readonly optionalProperties: number
  /** Number of properties in all objects. */
  readonly properties: number
  /** Number of objects. */
  readonly objects: number
}

/**
 * Walk a JSON Schema and list what the API subset of spec A4 does not allow.
 * The function is pure. It does not know the schema of this project.
 */
export const checkApiSchema = (schema: unknown): ApiSchemaCheck => {
  const violations: Array<string> = []
  let nullableProperties = 0
  let optionalProperties = 0
  let properties = 0
  let objects = 0

  const walk = (node: unknown, path: string): void => {
    if (!isRecord(node)) {
      violations.push(`${path}: a schema must be an object`)
      return
    }
    for (const key of Object.keys(node)) {
      const reason = UNSUPPORTED_KEYWORDS[key]
      if (reason !== undefined) {
        violations.push(`${path}: keyword "${key}" is not allowed (${reason})`)
      } else if (!ALLOWED_KEYWORDS.has(key)) {
        violations.push(`${path}: unknown keyword "${key}"`)
      }
    }

    const { pattern, minItems, type } = node
    if (pattern !== undefined && (typeof pattern !== "string" || UNSUPPORTED_PATTERN.test(pattern))) {
      violations.push(`${path}: "pattern" must be a string without look-around or back references`)
    }
    if (minItems !== undefined && minItems !== 0 && minItems !== 1) {
      violations.push(`${path}: "minItems" must be 0 or 1`)
    }
    if (
      type !== undefined &&
      typeof type !== "string" &&
      !(Array.isArray(type) && type.every((t) => typeof t === "string"))
    ) {
      violations.push(`${path}: "type" must be a string or an array of strings`)
    }

    if (Array.isArray(type) && ("enum" in node || "const" in node)) {
      const keyword = "enum" in node ? "enum" : "const"
      violations.push(
        `${path}: "${keyword}" must not be combined with a type array; use "anyOf" with a typed branch that has "${keyword}" and a branch {"type":"null"}`
      )
    }

    const isObject = type === "object" || (Array.isArray(type) && type.includes("object")) || "properties" in node
    if (isObject) {
      objects += 1
      if (node["additionalProperties"] !== false) {
        violations.push(`${path}: an object needs "additionalProperties": false`)
      }
      const own = node["properties"]
      if (!isRecord(own)) {
        violations.push(`${path}: an object needs "properties"`)
      } else {
        const required = node["required"]
        const requiredNames = Array.isArray(required) ? required.filter((name) => typeof name === "string") : []
        for (const [name, child] of Object.entries(own)) {
          properties += 1
          if (!requiredNames.includes(name)) {
            optionalProperties += 1
            violations.push(`${path}.${name}: the property is optional; make all properties required and use null`)
          }
          if (isRecord(child) && (Array.isArray(child["type"]) || "anyOf" in child)) {
            nullableProperties += 1
          }
          walk(child, `${path}.${name}`)
        }
        for (const name of requiredNames) {
          if (!(name in own)) {
            violations.push(`${path}: "required" names the unknown property "${name}"`)
          }
        }
      }
    }

    if ("items" in node) {
      walk(node["items"], `${path}[]`)
    }
    const anyOf = node["anyOf"]
    if (anyOf !== undefined) {
      if (!Array.isArray(anyOf)) {
        violations.push(`${path}: "anyOf" must be an array`)
      } else {
        anyOf.forEach((branch, position) => walk(branch, `${path}.anyOf[${position}]`))
      }
    }
  }

  walk(schema, "$")
  if (!isRecord(schema) || schema["type"] !== "object") {
    violations.push('$: the root schema must have type "object"')
  }
  if (nullableProperties > MAX_NULLABLE_PROPERTIES) {
    violations.push(
      `${nullableProperties} properties use anyOf or a type array; the limit is ${MAX_NULLABLE_PROPERTIES}`
    )
  }
  if (optionalProperties > MAX_OPTIONAL_PROPERTIES) {
    violations.push(`${optionalProperties} optional properties; the limit is ${MAX_OPTIONAL_PROPERTIES}`)
  }
  return {
    violations,
    nullableProperties,
    optionalProperties,
    properties,
    objects,
  }
}
