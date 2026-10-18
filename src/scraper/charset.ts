import { Option, Result, Schema } from "effect"

export class CharsetError extends Schema.TaggedError<CharsetError, { readonly brand: unique symbol }>()(
  "CharsetError",
  { label: Schema.String, message: Schema.String }
) {}

export type CharsetSource = "header" | "meta" | "default"

export interface Charset {
  /** Canonical encoding name, for example `windows-1251`. */
  readonly label: string
  readonly source: CharsetSource
}

export interface DecodedText {
  readonly text: string
  readonly charset: Charset
}

export interface DecodeOptions {
  /** Value of the `Content-Type` response header, if any. */
  readonly contentType: Option.Option<string>
  /** Charset to use when the header and the document do not name one. */
  readonly defaultLabel: string
  /** Look for `<meta charset>` and `<meta http-equiv>` in the first bytes of the body. */
  readonly sniffMeta: boolean
}

/** Number of leading bytes that the `<meta>` search reads. */
export const META_SNIFF_BYTES = 2048

/** Charset of recipe pages when nothing else is known (D5). */
export const DEFAULT_PAGE_CHARSET = "windows-1251"

/**
 * The canonical name that `TextDecoder` uses for `label`.
 * `None` when this Node.js build does not know the label.
 */
export const canonicalLabel = (label: string): Option.Option<string> =>
  Result.getSuccess(Result.try(() => new TextDecoder(label.trim()).encoding))

/** Charset parameter of a `Content-Type` value: `text/html; charset="windows-1251"` gives `windows-1251`. */
export const charsetFromContentType = (contentType: string): Option.Option<string> =>
  Option.fromNullishOr(/;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1])

/**
 * Charset named in the first bytes of an HTML document.
 * The search reads the bytes as latin1 and looks at `<meta charset="...">`
 * and `<meta http-equiv="Content-Type" content="...; charset=...">`.
 */
export const charsetFromMeta = (bytes: Uint8Array): Option.Option<string> => {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, META_SNIFF_BYTES))
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const label = /\bcharset\s*=\s*["']?\s*([A-Za-z0-9_:.-]+)/i.exec(tag[0])?.[1]
    if (label !== undefined) {
      return Option.some(label)
    }
  }
  return Option.none()
}

/**
 * Choose the charset: `Content-Type` header, then `<meta>`, then the default.
 * A label that this Node.js build does not support is skipped.
 */
export const detectCharset = (bytes: Uint8Array, options: DecodeOptions): Result.Result<Charset, CharsetError> => {
  const candidates: ReadonlyArray<{
    readonly source: CharsetSource
    readonly label: Option.Option<string>
  }> = [
    {
      source: "header",
      label: options.contentType.pipe(Option.flatMap(charsetFromContentType)),
    },
    {
      source: "meta",
      label: options.sniffMeta ? charsetFromMeta(bytes) : Option.none(),
    },
    { source: "default", label: Option.some(options.defaultLabel) },
  ]
  for (const candidate of candidates) {
    const label = candidate.label.pipe(Option.flatMap(canonicalLabel))
    if (Option.isSome(label)) {
      return Result.succeed({ label: label.value, source: candidate.source })
    }
  }
  return Result.fail(
    new CharsetError({
      label: options.defaultLabel,
      message: `This Node.js build cannot decode the charset "${options.defaultLabel}". Use an official Node.js build with full ICU.`,
    })
  )
}

/** Decode `bytes` to text. Invalid byte sequences become U+FFFD. */
export const decodeText = (bytes: Uint8Array, options: DecodeOptions): Result.Result<DecodedText, CharsetError> =>
  detectCharset(bytes, options).pipe(
    Result.map((charset) => ({
      text: new TextDecoder(charset.label).decode(bytes),
      charset,
    }))
  )
