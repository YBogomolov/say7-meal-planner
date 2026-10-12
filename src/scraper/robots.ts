import { RegExp as Re } from "effect"

export interface RobotsRule {
  readonly allow: boolean
  /** Path pattern. May contain `*` (any characters) and a final `$` (end of path). */
  readonly pattern: string
}

export interface RobotsGroup {
  /** Lower-case `User-agent` values of the group. */
  readonly agents: ReadonlyArray<string>
  readonly rules: ReadonlyArray<RobotsRule>
}

export interface Robots {
  readonly groups: ReadonlyArray<RobotsGroup>
  readonly sitemaps: ReadonlyArray<string>
}

interface MutableGroup {
  readonly agents: Array<string>
  readonly rules: Array<RobotsRule>
}

/**
 * Parse robots.txt text.
 * A group starts with one or more `User-agent` lines and holds the `Allow` and `Disallow` lines after them.
 * An empty `Disallow:` value means "allow all", so the parser drops that rule.
 * Unknown fields are ignored.
 */
export const parseRobots = (text: string): Robots => {
  const groups: Array<MutableGroup> = []
  const sitemaps: Array<string> = []
  let current: MutableGroup | undefined
  let inAgentLines = false

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim()
    const colon = line.indexOf(":")
    if (colon < 0) {
      continue
    }
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()

    if (field === "user-agent") {
      if (current === undefined || !inAgentLines) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      inAgentLines = true
    } else if (field === "allow" || field === "disallow") {
      inAgentLines = false
      if (current !== undefined && value !== "") {
        current.rules.push({ allow: field === "allow", pattern: value })
      }
    } else if (field === "sitemap") {
      if (value !== "") {
        sitemaps.push(value)
      }
    }
  }
  return { groups, sitemaps }
}

/** Does `pattern` match the start of `path`? Supports `*` and a final `$`. */
export const patternMatches = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith("$")
  const body = anchored ? pattern.slice(0, -1) : pattern
  const source = body.split("*").map(Re.escape).join(".*")
  return new RegExp(`^${source}${anchored ? "$" : ""}`, "s").test(path)
}

/** The product token of a User-Agent string: `say7-meal-planner/0.1 (...)` gives `say7-meal-planner`. */
export const productToken = (userAgent: string): string => userAgent.split(/[\s/]/)[0]?.toLowerCase() ?? ""

/**
 * Decide if `userAgent` may fetch `path` (path plus query string, for example `/a.html?x=1`).
 * Use the groups that name the product token of the agent. If there are none, use the groups for `*`.
 * The longest matching pattern wins. On equal length, `Allow` wins. No matching rule means allowed.
 */
export const isAllowed = (robots: Robots, userAgent: string, path: string): boolean => {
  const token = productToken(userAgent)
  const named = robots.groups.filter((group) => group.agents.includes(token))
  const groups = named.length > 0 ? named : robots.groups.filter((group) => group.agents.includes("*"))

  let best: { readonly allow: boolean; readonly length: number } | undefined
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!patternMatches(rule.pattern, path)) {
        continue
      }
      const length = rule.pattern.length
      if (best === undefined || length > best.length || (length === best.length && rule.allow && !best.allow)) {
        best = { allow: rule.allow, length }
      }
    }
  }
  return best?.allow ?? true
}
