/**
 * The JSON Schema that the API gets in `output_config.format` (spec A3, A4).
 *
 * The API accepts only a subset of JSON Schema (spec A4):
 * every object has `additionalProperties: false`, all properties are required, "no value" is `null`,
 * and there is no `minimum`, `maximum`, `minLength` or `maxLength`.
 * A node with `enum` or `const` has a single `type`. A nullable enum uses `anyOf` (see `nullableEnumOf`).
 * The ranges are checked by the Effect Schema `Enrichment` after the response (src/domain/enriched-recipe.ts).
 *
 * The enum values are written out here on purpose, so that a test can compare them with the Effect Schema.
 * The order of `properties` is the order in which the model writes the fields:
 * the ingredients come first, so that the families, the vegetarian flag and the heat follow from the items.
 */

const enumOf = (...values: ReadonlyArray<string>) => ({ type: "string", enum: values }) as const

/**
 * A value that is one of `values` or `null`.
 * The API rejects `enum` together with a type array (`{"type": ["string", "null"], "enum": [..., null]}`),
 * so the enum stays in a typed branch and `null` is a branch of its own.
 * The Effect Schema side is `Schema.NullOr(Schema.Literals(values))`, so the decoded type has `null` as well.
 */
const nullableEnumOf = (...values: ReadonlyArray<string>) =>
  ({ anyOf: [enumOf(...values), { type: "null" }] }) as const

const array = <const Items extends object>(items: Items) => ({ type: "array", items }) as const

/** An object schema in which every property is required and no other property is allowed. */
const object = <const Properties extends Readonly<Record<string, object>>>(properties: Properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties
}) as const

const INGREDIENT_ITEM = object({
  line: { type: "integer" },
  item: { type: "string" },
  detail: { type: ["string", "null"] },
  category: enumOf(
    "poultry",
    "meat",
    "fish",
    "seafood",
    "dairy",
    "eggs",
    "vegetable",
    "fruit",
    "herb",
    "grain",
    "pasta",
    "legume",
    "bakery",
    "canned",
    "frozen",
    "sauce",
    "spice",
    "oil",
    "sweet",
    "nuts",
    "other"
  ),
  pantry: { type: "boolean" },
  quantity: { type: ["number", "null"] },
  unit: nullableEnumOf("g", "ml", "pcs", "tbsp", "tsp", "pinch", "bunch", "clove", "slice", "pack"),
  grams: { type: ["number", "null"] },
  optional: { type: "boolean" }
})

export const ENRICHMENT_JSON_SCHEMA = object({
  ingredients: array(INGREDIENT_ITEM),
  proteinFamilies: array(
    enumOf("chicken", "turkey", "duck", "pork", "beef", "lamb", "rabbit", "fish", "seafood")
  ),
  vegetarian: { type: "boolean" },
  dishType: enumOf("soup", "main", "side", "salad", "snack", "savory_bake", "pancakes", "sauce", "other"),
  mealFit: enumOf("full_meal", "needs_side", "side_only", "not_a_meal"),
  sideHint: { type: ["string", "null"] },
  servings: object({
    min: { type: "integer" },
    max: { type: "integer" },
    source: enumOf("page", "estimated")
  }),
  activeMinutes: { type: "integer" },
  totalMinutes: { type: "integer" },
  longWaitHours: { type: ["number", "null"] },
  heat: { type: "integer", enum: [0, 1, 2, 3] },
  difficulty: { type: "integer", enum: [1, 2, 3] },
  equipment: array(
    enumOf(
      "hob",
      "oven",
      "microwave",
      "air_fryer",
      "food_processor",
      "blender",
      "immersion_blender",
      "mixer",
      "grill",
      "slow_cooker",
      "deep_fryer",
      "special"
    )
  ),
  fridgeDays: { type: "integer" },
  freezable: { type: "boolean" },
  reheats: enumOf("well", "ok", "poor", "served_cold")
})

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
  "title"
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
  $defs: "not used in this project"
}

/** A regular expression with a look-around or a back reference does not work in the API. */
const UNSUPPORTED_PATTERN = /\(\?<?[=!]|\\[1-9]|\\k</

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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
    if (type !== undefined && typeof type !== "string" && !(Array.isArray(type) && type.every((t) => typeof t === "string"))) {
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
    violations.push("$: the root schema must have type \"object\"")
  }
  if (nullableProperties > MAX_NULLABLE_PROPERTIES) {
    violations.push(
      `${nullableProperties} properties use anyOf or a type array; the limit is ${MAX_NULLABLE_PROPERTIES}`
    )
  }
  if (optionalProperties > MAX_OPTIONAL_PROPERTIES) {
    violations.push(`${optionalProperties} optional properties; the limit is ${MAX_OPTIONAL_PROPERTIES}`)
  }
  return { violations, nullableProperties, optionalProperties, properties, objects }
}
