const EXTRA: ReadonlyMap<string, number> = new Map([
  ["№", 0xb9], // №
  ["«", 0xab], // «
  ["»", 0xbb], // »
  ["—", 0x97], // em dash
  ["°", 0xb0], // degree sign
  [" ", 0xa0] // no-break space
])

const byteFor = (char: string): number => {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x80) return code
  if (code >= 0x0410 && code <= 0x044f) return code - 0x0410 + 0xc0 // А..я
  if (code === 0x0401) return 0xa8 // Ё
  if (code === 0x0451) return 0xb8 // ё
  const extra = EXTRA.get(char)
  if (extra !== undefined) return extra
  throw new Error(`Test helper cannot encode U+${code.toString(16)} as windows-1251`)
}

/** Encode text as windows-1251 bytes. Supports ASCII, Cyrillic and a few signs. */
export const encodeWindows1251 = (text: string): Uint8Array => Uint8Array.from([...text].map(byteFor))
