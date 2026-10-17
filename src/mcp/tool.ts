import { Cause, Effect, Result, Schema } from "effect"

/** What a tool returns to the client: text blocks, and a flag for an error (the text is Russian then). */
export interface ToolResult {
  readonly texts: ReadonlyArray<string>
  readonly isError: boolean
}

/** The JSON Schema of the input of a tool. MCP needs an object at the root. */
export interface ToolInputSchema {
  readonly type: "object"
  readonly [key: string]: unknown
}

/** A tool with the input type erased: the server only needs the JSON Schema and `call`. */
export interface Tool<R> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ToolInputSchema
  /** Decode the raw arguments, run the tool and turn every failure into a result with `isError`. Never fails. */
  readonly call: (raw: unknown) => Effect.Effect<ToolResult, never, R>
}

/** Decoding options for tool arguments: report every problem of the shape in one pass. */
export const ARGUMENT_DECODE_OPTIONS = { errors: "all" } as const

const ok = (texts: ReadonlyArray<string>): ToolResult => ({
  texts,
  isError: false,
})
const failed = (text: string): ToolResult => ({ texts: [text], isError: true })

/**
 * The JSON Schema (draft 2020-12) of an input schema. One source of truth: `decodeArguments` decodes with the same schema.
 * The root is an object. Shared definitions, if any, go to `$defs`.
 */
export const inputJsonSchema = <A, I>(schema: Schema.Codec<A, I>): ToolInputSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  const { type: _type, ...rest } = document.schema
  const hasDefinitions = Object.keys(document.definitions).length > 0
  return {
    ...rest,
    type: "object",
    ...(hasDefinitions ? { $defs: document.definitions } : {}),
  }
}

/** Decode the arguments of a tool call. The failure is a Russian text with the details of the decoder. */
export const decodeArguments = <A, I>(
  name: string,
  schema: Schema.Codec<A, I>,
  raw: unknown
): Result.Result<A, string> =>
  Schema.decodeUnknownResult(schema)(raw ?? {}, ARGUMENT_DECODE_OPTIONS).pipe(
    Result.mapError((error) => `Неверные аргументы инструмента ${name}.\n${error.message}`)
  )

/**
 * Define a tool. `run` gets the decoded arguments and returns the text blocks.
 * A failure of `run` has a `message` (the tagged errors of the planner have one): it becomes the Russian text of the error.
 */
export const defineTool = <A, I, E extends { readonly message: string }, R>(definition: {
  readonly name: string
  readonly description: string
  readonly input: Schema.Codec<A, I>
  readonly run: (args: A) => Effect.Effect<ReadonlyArray<string>, E, R>
}): Tool<R> => ({
  name: definition.name,
  description: definition.description,
  inputSchema: inputJsonSchema(definition.input),
  call: (raw) => {
    const args = decodeArguments(definition.name, definition.input, raw)
    if (Result.isFailure(args)) {
      return Effect.succeed(failed(args.failure))
    }
    return definition.run(args.success).pipe(
      Effect.map(ok),
      Effect.catch((error) => Effect.succeed(failed(`Ошибка инструмента ${definition.name}: ${error.message}`))),
      Effect.catchCause((cause) =>
        Effect.succeed(failed(`Внутренняя ошибка инструмента ${definition.name}.\n${Cause.pretty(cause)}`))
      )
    )
  },
})
