import { assert, describe, it } from "@effect/vitest"
import { Option, Result } from "effect"
import {
  canonicalLabel,
  charsetFromContentType,
  charsetFromMeta,
  decodeText,
  detectCharset,
  META_SNIFF_BYTES,
} from "../src/scraper/charset.ts"
import type { DecodeOptions } from "../src/scraper/charset.ts"
import { encodeWindows1251 } from "./support/win1251.ts"

const page = (head: string, body = "Куриные сердечки") =>
  encodeWindows1251(`<html><head>${head}</head><body>${body}</body></html>`)

const pageOptions = (contentType: string | null): DecodeOptions => ({
  contentType: Option.fromNullishOr(contentType),
  defaultLabel: "windows-1251",
  sniffMeta: true,
})

const decode = (bytes: Uint8Array, options: DecodeOptions) => {
  const result = decodeText(bytes, options)
  if (Result.isFailure(result)) {
    assert.fail(result.failure.message)
  }
  return result.success
}

describe("charsetFromContentType", () => {
  it.each([
    ["text/html; charset=windows-1251", "windows-1251"],
    ["text/html; charset=utf-8", "utf-8"],
    ["text/html;charset=UTF-8", "UTF-8"],
    ['text/html; charset="windows-1251"', "windows-1251"],
    ["text/xml; charset=utf-8; boundary=x", "utf-8"],
    ["text/plain; charset=windows-1251", "windows-1251"],
  ])("reads %s", (header, label) => {
    assert.strictEqual(Option.getOrNull(charsetFromContentType(header)), label)
  })

  it("returns None without a charset parameter", () => {
    assert.isTrue(Option.isNone(charsetFromContentType("text/html")))
  })
})

describe("charsetFromMeta", () => {
  it("reads <meta charset>", () => {
    assert.strictEqual(Option.getOrNull(charsetFromMeta(page('<meta charset="windows-1251">'))), "windows-1251")
    assert.strictEqual(Option.getOrNull(charsetFromMeta(page("<meta charset=koi8-r>"))), "koi8-r")
  })

  it("reads <meta http-equiv> with the attributes in either order", () => {
    const first = '<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">'
    const second = "<META content='text/html; charset=windows-1251' http-equiv='Content-Type'>"
    assert.strictEqual(Option.getOrNull(charsetFromMeta(page(first))), "windows-1251")
    assert.strictEqual(Option.getOrNull(charsetFromMeta(page(second))), "windows-1251")
  })

  it("ignores meta tags without a charset", () => {
    assert.isTrue(Option.isNone(charsetFromMeta(page('<meta name="viewport" content="width=device-width">'))))
  })

  it("reads only the first 2 KB", () => {
    const filler = "x".repeat(META_SNIFF_BYTES)
    assert.isTrue(Option.isNone(charsetFromMeta(page(`<!-- ${filler} --><meta charset="utf-8">`))))
  })
})

describe("detectCharset", () => {
  it("prefers the header over the meta tag", () => {
    const bytes = page('<meta charset="windows-1251">')
    const charset = Result.getOrThrow(detectCharset(bytes, pageOptions("text/html; charset=utf-8")))
    assert.deepStrictEqual(charset, { label: "utf-8", source: "header" })
  })

  it("uses the meta tag when the header has no charset", () => {
    const bytes = page('<meta charset="koi8-r">')
    const charset = Result.getOrThrow(detectCharset(bytes, pageOptions("text/html")))
    assert.deepStrictEqual(charset, { label: "koi8-r", source: "meta" })
  })

  it("uses the default when nothing names a charset", () => {
    const charset = Result.getOrThrow(detectCharset(page(""), pageOptions(null)))
    assert.deepStrictEqual(charset, {
      label: "windows-1251",
      source: "default",
    })
  })

  it("skips a label that Node.js does not know", () => {
    const charset = Result.getOrThrow(
      detectCharset(page('<meta charset="no-such-charset">'), pageOptions("text/html; charset=also-unknown"))
    )
    assert.deepStrictEqual(charset, {
      label: "windows-1251",
      source: "default",
    })
  })

  it("does not read meta tags when sniffing is off", () => {
    const bytes = page('<meta charset="koi8-r">')
    const charset = Result.getOrThrow(
      detectCharset(bytes, {
        contentType: Option.none(),
        defaultLabel: "utf-8",
        sniffMeta: false,
      })
    )
    assert.deepStrictEqual(charset, { label: "utf-8", source: "default" })
  })

  it("fails when even the default label is unknown", () => {
    const result = detectCharset(new Uint8Array(), {
      contentType: Option.none(),
      defaultLabel: "no-such-charset",
      sniffMeta: false,
    })
    assert.isTrue(Result.isFailure(result))
  })
})

describe("canonicalLabel", () => {
  it("normalises known labels and rejects unknown ones", () => {
    assert.strictEqual(Option.getOrNull(canonicalLabel("WINDOWS-1251")), "windows-1251")
    assert.strictEqual(Option.getOrNull(canonicalLabel("cp1251")), "windows-1251")
    assert.strictEqual(Option.getOrNull(canonicalLabel("UTF8")), "utf-8")
    assert.isTrue(Option.isNone(canonicalLabel("nonsense")))
  })
})

describe("decodeText", () => {
  it("decodes windows-1251 Cyrillic, including Ё and ё", () => {
    const text = "Куриные сердечки, Ёлка, ёж, № 5 «щи»"
    const decoded = decode(encodeWindows1251(text), pageOptions("text/html; charset=windows-1251"))
    assert.strictEqual(decoded.text, text)
  })

  it("decodes with the default when the page names no charset", () => {
    const decoded = decode(page(""), pageOptions(null))
    assert.include(decoded.text, "Куриные сердечки")
    assert.strictEqual(decoded.charset.source, "default")
  })

  it("decodes with the meta tag when the header has no charset", () => {
    const decoded = decode(
      page('<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">'),
      pageOptions("text/html")
    )
    assert.include(decoded.text, "Куриные сердечки")
    assert.strictEqual(decoded.charset.source, "meta")
  })

  it("decodes UTF-8", () => {
    const bytes = new TextEncoder().encode("Куриные сердечки")
    const decoded = decode(bytes, {
      contentType: Option.some("text/xml; charset=utf-8"),
      defaultLabel: "utf-8",
      sniffMeta: false,
    })
    assert.strictEqual(decoded.text, "Куриные сердечки")
  })

  it("replaces invalid bytes and does not throw", () => {
    const decoded = decode(Uint8Array.from([0x61, 0xff, 0xfe, 0x62]), {
      contentType: Option.some("text/plain; charset=utf-8"),
      defaultLabel: "utf-8",
      sniffMeta: false,
    })
    assert.strictEqual(decoded.text, "a��b")
  })
})
