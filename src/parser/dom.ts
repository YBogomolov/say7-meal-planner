import type { DefaultTreeAdapterTypes } from "parse5"
import { cleanText } from "./text.ts"

/** Small helpers over the tree of `parse5` (the default tree adapter). All functions are pure. */

export type Node = DefaultTreeAdapterTypes.Node
export type Element = DefaultTreeAdapterTypes.Element
export type TextNode = DefaultTreeAdapterTypes.TextNode

export const isElement = (node: Node): node is Element => "tagName" in node

export const isText = (node: Node): node is TextNode => "value" in node

export const childNodes = (node: Node): ReadonlyArray<Node> => ("childNodes" in node ? node.childNodes : [])

/** The attribute value, or `undefined` when the element has no such attribute. */
export const attr = (element: Element, name: string): string | undefined =>
  element.attrs.find((attribute) => attribute.name === name)?.value

/** True when the `class` attribute has `name` as one of its space-separated words. */
export const hasClass = (element: Element, name: string): boolean =>
  (attr(element, "class") ?? "").split(/\s+/).includes(name)

/** All descendant nodes of `node` (elements and text), in document order (pre-order). */
export const descendantNodes = (node: Node): ReadonlyArray<Node> => {
  const found: Array<Node> = []
  const visit = (parent: Node): void => {
    for (const child of childNodes(parent)) {
      found.push(child)
      visit(child)
    }
  }
  visit(node)
  return found
}

/** All descendant elements of `node`, in document order (pre-order). The node itself is not included. */
export const descendants = (node: Node): ReadonlyArray<Element> => descendantNodes(node).filter(isElement)

export const findAll = (node: Node, predicate: (element: Element) => boolean): ReadonlyArray<Element> =>
  descendants(node).filter(predicate)

export const findFirst = (node: Node, predicate: (element: Element) => boolean): Element | undefined =>
  descendants(node).find(predicate)

export const byTag = (tagName: string) => (element: Element): boolean => element.tagName === tagName

export const byId = (id: string) => (element: Element): boolean => attr(element, "id") === id

/** True when `node` is `ancestor` or lies inside it. */
export const isInside = (node: Node, ancestor: Element): boolean => {
  let current: Node | null = node
  while (current !== null) {
    if (current === ancestor) {
      return true
    }
    current = "parentNode" in current ? current.parentNode : null
  }
  return false
}

/** True when an ancestor of `element` (not the element itself) satisfies `predicate`. */
export const hasAncestor = (element: Element, predicate: (ancestor: Element) => boolean): boolean => {
  let current = element.parentNode
  while (current !== null) {
    if (isElement(current) && predicate(current)) {
      return true
    }
    current = "parentNode" in current ? current.parentNode : null
  }
  return false
}

/**
 * The nodes that follow `heading` in its parent, up to the next sibling element for which `isNextHeading` is true.
 * The text of a recipe section sits there: the heading and its section share one parent.
 */
export const siblingsAfter = (heading: Element, isNextHeading: (element: Element) => boolean): ReadonlyArray<Node> => {
  const parent = heading.parentNode
  if (parent === null) {
    return []
  }
  const following = parent.childNodes.slice(parent.childNodes.indexOf(heading) + 1)
  const stop = following.findIndex((node) => isElement(node) && isNextHeading(node))
  return stop === -1 ? following : following.slice(0, stop)
}

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "figure", "footer", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "th", "tr", "ul"
])

/** Elements without text for the reader: pictures, scripts, styles. */
const SKIPPED_TAGS: ReadonlySet<string> = new Set(["img", "script", "style", "noscript", "template", "svg", "picture"])

/**
 * The visible text of the nodes as clean lines.
 * `<br>` and the start and the end of a block element (`p`, `div`, `li`, headings, …) end a line.
 * Inline elements (`span`, `a`, `b`) do not. Pictures, scripts and styles give no text.
 * Lines that stay empty are dropped.
 */
export const textLines = (nodes: ReadonlyArray<Node>): ReadonlyArray<string> => {
  const lines: Array<string> = []
  let current = ""

  const flush = (): void => {
    const line = cleanText(current)
    current = ""
    if (line !== "") {
      lines.push(line)
    }
  }

  const walk = (node: Node): void => {
    if (isText(node)) {
      current += node.value
      return
    }
    if (!isElement(node)) {
      childNodes(node).forEach(walk)
      return
    }
    if (SKIPPED_TAGS.has(node.tagName)) {
      return
    }
    if (node.tagName === "br") {
      flush()
      return
    }
    const block = BLOCK_TAGS.has(node.tagName)
    if (block) {
      flush()
    }
    node.childNodes.forEach(walk)
    if (block) {
      flush()
    }
  }

  nodes.forEach(walk)
  flush()
  return lines
}

/** The text of an element as one clean line: the lines joined with a space. */
export const textOf = (...nodes: ReadonlyArray<Node>): string => textLines(nodes).join(" ")

/**
 * The first element that has a text node child with exactly this clean text (a trailing `:` does not count),
 * optionally limited to elements with one of the given tag names.
 */
export const findByOwnText = (
  root: Node,
  text: string,
  tagNames?: ReadonlySet<string>
): Element | undefined => {
  for (const node of descendantNodes(root)) {
    if (isText(node) && cleanText(node.value).replace(/:$/, "") === text) {
      const parent = node.parentNode
      if (parent !== null && isElement(parent) && (tagNames === undefined || tagNames.has(parent.tagName))) {
        return parent
      }
    }
  }
  return undefined
}
