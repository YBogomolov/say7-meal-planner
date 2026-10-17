/**
 * Exact decimal arithmetic for quantities (spec P4.5, "decimal-safe").
 *
 * A `Decimal` is `units / 10^scale` with a whole number `units`. A number from JSON, such as `0.3`, is read from its
 * shortest text form, so `0.3` is exactly 3/10 and not the nearest binary fraction. Products and sums are exact.
 * The only rounding is the last step: `roundTo` gives a number with the wanted decimals, half up.
 */
export interface Decimal {
  readonly units: bigint
  readonly scale: number
}

export const ZERO: Decimal = { units: 0n, scale: 0 }

const NUMBER_TEXT = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/

/** The exact decimal of a finite number. A number that is not finite (it never comes from a schema) gives zero. */
export const decimalOf = (value: number): Decimal => {
  const match = NUMBER_TEXT.exec(String(value))
  if (match === null) {
    return ZERO
  }
  const fraction = match[3] ?? ""
  const exponent = Number(match[4] ?? "0") - fraction.length
  const digits = BigInt(`${match[2] ?? "0"}${fraction}`)
  const signed = match[1] === "-" ? -digits : digits
  return exponent >= 0 ? { units: signed * 10n ** BigInt(exponent), scale: 0 } : { units: signed, scale: -exponent }
}

const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent)

export const add = (a: Decimal, b: Decimal): Decimal => {
  const scale = Math.max(a.scale, b.scale)
  return {
    units: a.units * pow10(scale - a.scale) + b.units * pow10(scale - b.scale),
    scale,
  }
}

export const multiply = (a: Decimal, b: Decimal): Decimal => ({
  units: a.units * b.units,
  scale: a.scale + b.scale,
})

/** The sum of the decimals. */
export const sum = (values: Iterable<Decimal>): Decimal => {
  let total = ZERO
  for (const value of values) {
    total = add(total, value)
  }
  return total
}

/** The value as a number with `places` decimals. A tie rounds away from zero (0.125 with 2 places is 0.13). */
export const roundTo = (value: Decimal, places: number): number => {
  const magnitude = value.units < 0n ? -value.units : value.units
  const sign = value.units < 0n ? -1 : 1
  if (value.scale <= places) {
    return (sign * Number(magnitude * pow10(places - value.scale))) / 10 ** places
  }
  const divisor = pow10(value.scale - places)
  const quotient = magnitude / divisor
  const rounded = (magnitude % divisor) * 2n >= divisor ? quotient + 1n : quotient
  return (sign * Number(rounded)) / 10 ** places
}
