/**
 * An independent check of the JSON Schema subset of spec A4.
 * It does not use `checkApiSchema` of the source, so a mistake in that function cannot hide a mistake in the schema.
 *
 * Spec A4: every object has `additionalProperties: false`; no `minimum`/`maximum`, no `minLength`/`maxLength`;
 * `minItems` only 0 or 1; no recursion; at most 16 properties with `anyOf` or a type array; at most 24 optional properties.
 * The list below adds the keywords that the structured outputs of the API do not support either.
 */
export const A4_FORBIDDEN_KEYWORDS: ReadonlyArray<string> = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
  "$defs",
  "definitions",
  "$dynamicRef"
]

export const A4_MAX_UNION_PROPERTIES = 16
export const A4_MAX_OPTIONAL_PROPERTIES = 24

export interface A4Walk {
  /** Every reason why the schema breaks spec A4. Empty when the schema is valid. */
  readonly problems: ReadonlyArray<string>
  readonly objects: number
  readonly properties: number
  readonly optionalProperties: number
  readonly unionProperties: number
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const walkA4 = (schema: unknown): A4Walk => {
  const problems: Array<string> = []
  let objects = 0
  let properties = 0
  let optionalProperties = 0
  let unionProperties = 0

  const walk = (node: unknown, path: string): void => {
    if (!isRecord(node)) {
      problems.push(`${path}: not an object`)
      return
    }
    for (const keyword of A4_FORBIDDEN_KEYWORDS) {
      if (keyword in node) {
        problems.push(`${path}: forbidden keyword ${keyword}`)
      }
    }
    if ("minItems" in node && node["minItems"] !== 0 && node["minItems"] !== 1) {
      problems.push(`${path}: minItems must be 0 or 1`)
    }

    const type = node["type"]
    if (type === "object" || (Array.isArray(type) && type.includes("object")) || "properties" in node) {
      objects += 1
      if (node["additionalProperties"] !== false) {
        problems.push(`${path}: additionalProperties is not false`)
      }
      const own = node["properties"]
      const required = Array.isArray(node["required"]) ? node["required"] : []
      if (isRecord(own)) {
        for (const [name, child] of Object.entries(own)) {
          properties += 1
          if (!required.includes(name)) {
            optionalProperties += 1
          }
          if (isRecord(child) && ("anyOf" in child || Array.isArray(child["type"]))) {
            unionProperties += 1
          }
          walk(child, `${path}.${name}`)
        }
      }
    }
    if ("items" in node) {
      walk(node["items"], `${path}[]`)
    }
    const anyOf = node["anyOf"]
    if (Array.isArray(anyOf)) {
      anyOf.forEach((branch, position) => walk(branch, `${path}.anyOf[${position}]`))
    }
  }

  walk(schema, "$")
  if (unionProperties > A4_MAX_UNION_PROPERTIES) {
    problems.push(`${unionProperties} properties with anyOf or a type array; the limit is ${A4_MAX_UNION_PROPERTIES}`)
  }
  if (optionalProperties > A4_MAX_OPTIONAL_PROPERTIES) {
    problems.push(`${optionalProperties} optional properties; the limit is ${A4_MAX_OPTIONAL_PROPERTIES}`)
  }
  return { problems, objects, properties, optionalProperties, unionProperties }
}
