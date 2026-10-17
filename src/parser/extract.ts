import { Option } from "effect"
import type { Category, IngredientGroup } from "../domain/parsed-recipe.ts"
import {
  attr,
  byId,
  byTag,
  descendants,
  findAll,
  findByOwnText,
  findFirst,
  hasAncestor,
  hasClass,
  isElement,
  siblingsAfter,
  textLines,
  textOf,
} from "./dom.ts"
import type { Element, Node } from "./dom.ts"

/**
 * Page-level readers. Each one reads one part of a recipe page of say7.info.
 * The selectors come from the real pages in `test/fixtures/real/`:
 *
 *   <title>/<h1>                        title
 *   <link rel="canonical">              url
 *   main .p-summary > p                 intro
 *   .p-yield                            yield text
 *   h2 "Ингредиенты" + siblings         ingredient groups: h3 = group title, li = line
 *   h2 "Приготовление" + siblings       steps: div.step
 *   header "Категории рецепта" + siblings  categories: a[href="/cook/kitchen/<id>-<slug>/"]
 *   #sitepos                            categories, when the page has no block "Категории рецепта"
 *   h2 "Комментарии (N)"                comments count
 *   header > p "Похожие"                similar recipes: a[href="/cook/recipe/<id>-…"]
 */

const SECTION_HEADING = new Set(["h2"])

const isH2 = byTag("h2")

/** The elements of a node list and all their descendants, in document order. */
const elementsOf = (nodes: ReadonlyArray<Node>): ReadonlyArray<Element> =>
  nodes.flatMap((node) => (isElement(node) ? [node, ...descendants(node)] : []))

/** The elements of the section that starts with the `h2` heading `label`, or none if the page has no such heading. */
const sectionElements = (root: Node, label: string): ReadonlyArray<Element> => {
  const heading = findByOwnText(root, label, SECTION_HEADING)
  return heading === undefined ? [] : elementsOf(siblingsAfter(heading, isH2))
}

/** The text of the first `<h1>`: entities are decoded, `&nbsp;` is a space, white space is collapsed. */
export const extractTitle = (document: Node): string => {
  const heading = findFirst(document, byTag("h1"))
  return heading === undefined ? "" : textOf(heading)
}

/** The canonical URL of the page: `<link rel="canonical">`, or else `<meta property="og:url">`. */
export const extractUrl = (document: Node): Option.Option<string> => {
  const canonical = findAll(document, byTag("link")).find(
    (element) => attr(element, "rel")?.toLowerCase() === "canonical"
  )
  const ogUrl = findAll(document, byTag("meta")).find((element) => attr(element, "property") === "og:url")
  const url =
    (canonical === undefined ? undefined : attr(canonical, "href")) ??
    (ogUrl === undefined ? undefined : attr(ogUrl, "content"))
  return Option.fromNullishOr(url?.trim()).pipe(Option.filter((value) => value !== ""))
}

/** The recipe ID in a URL like `https://www.say7.info/cook/recipe/1590-Tort-Tri.html`. */
export const idFromUrl = (url: string): Option.Option<number> =>
  Option.fromNullishOr(/\/cook\/recipe\/(\d+)-[^/?#]*\.html(?:[?#]|$)/.exec(url)?.[1]).pipe(Option.map(Number))

const isQuote = (element: Element): boolean => hasClass(element, "explain") || element.tagName === "blockquote"

/**
 * The paragraphs of the description before the ingredient list: the `<p>` elements of `.p-summary`.
 * A quotation (`.explain`, `<blockquote>`) is not part of the author's text, so the extractor skips it.
 */
export const extractIntro = (root: Node): ReadonlyArray<string> => {
  const summary = findFirst(root, (element) => hasClass(element, "p-summary"))
  return summary === undefined
    ? []
    : findAll(summary, byTag("p"))
        .filter((paragraph) => !hasAncestor(paragraph, isQuote))
        .map((paragraph) => textOf(paragraph))
        .filter((text) => text !== "")
}

/**
 * The block after the heading "Ингредиенты". Each `<h3>` starts a group; each `<li>` is one line.
 * Lines before the first `<h3>` form a group without a title. A group without lines is dropped.
 */
export const extractIngredientGroups = (root: Node): ReadonlyArray<IngredientGroup> => {
  interface Draft {
    readonly title: string | null
    readonly items: Array<string>
  }
  const groups: Array<Draft> = []
  let current: Draft | undefined
  for (const element of sectionElements(root, "Ингредиенты")) {
    if (element.tagName === "h3") {
      current = { title: textOf(element) || null, items: [] }
      groups.push(current)
    } else if (element.tagName === "li") {
      const line = textOf(element)
      if (line !== "") {
        if (current === undefined) {
          current = { title: null, items: [] }
          groups.push(current)
        }
        current.items.push(line)
      }
    }
  }
  return groups.flatMap((group): ReadonlyArray<IngredientGroup> =>
    group.items.length === 0 ? [] : [{ title: group.title, items: group.items }]
  )
}

/**
 * The texts of the steps under the heading "Приготовление": one text for each `div.step`, in page order.
 * The line breaks (`<br>`) of a step become `\n`. A step without text (the last photo of the finished dish) is dropped.
 */
export const extractSteps = (root: Node): ReadonlyArray<string> =>
  sectionElements(root, "Приготовление")
    .filter((element) => element.tagName === "div" && hasClass(element, "step"))
    .map((element) => textLines([element]).join("\n"))
    .filter((text) => text !== "")

const KITCHEN_LINK = /\/cook\/kitchen\/(\d+)-([^/?#]+)/

const categoriesIn = (elements: ReadonlyArray<Element>): ReadonlyArray<Category> => {
  const seen = new Set<number>()
  const categories: Array<Category> = []
  for (const element of elements) {
    const match = element.tagName === "a" ? KITCHEN_LINK.exec(attr(element, "href") ?? "") : null
    const id = Number(match?.[1])
    const slug = match?.[2]
    const name = textOf(element)
    if (slug !== undefined && name !== "" && Number.isInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id)
      categories.push({ id, slug, name })
    }
  }
  return categories
}

export interface ExtractedCategories {
  readonly categories: ReadonlyArray<Category>
  /** True when the page has no block "Категории рецепта" and the categories come from the breadcrumb. */
  readonly fromBreadcrumb: boolean
}

/**
 * The categories of the recipe, without duplicates, in page order.
 * Source: the block "Категории рецепта". Some pages have no such block;
 * for these the extractor reads the breadcrumb at the top of the page (`#sitepos`) and sets `fromBreadcrumb`.
 * The menu of the site (`aria-label="Категории рецептов"`) is never a source.
 */
export const extractCategories = (document: Node): ExtractedCategories => {
  const heading = findByOwnText(document, "Категории рецепта")
  const fromBlock = heading === undefined ? [] : categoriesIn(elementsOf(siblingsAfter(heading, () => false)))
  if (fromBlock.length > 0) {
    return { categories: fromBlock, fromBreadcrumb: false }
  }
  const breadcrumb = findFirst(document, byId("sitepos"))
  const fromCrumb = breadcrumb === undefined ? [] : categoriesIn(descendants(breadcrumb))
  return { categories: fromCrumb, fromBreadcrumb: fromCrumb.length > 0 }
}

/** The clean text of the first element with the class `p-yield` ("8–10 порций", "100–110 штук"), or `None`. */
export const extractYieldText = (root: Node): Option.Option<string> =>
  Option.fromNullishOr(findFirst(root, (element) => hasClass(element, "p-yield"))).pipe(
    Option.map((element) => textOf(element)),
    Option.filter((text) => text !== "")
  )

/** N from the heading "Комментарии (N)". */
export const extractCommentsCount = (document: Node): Option.Option<number> => {
  for (const heading of findAll(document, isH2)) {
    const match = /^Комментарии\s*\((\d+)\)$/.exec(textOf(heading))
    if (match?.[1] !== undefined) {
      return Option.some(Number(match[1]))
    }
  }
  return Option.none()
}

const RECIPE_LINK = /\/cook\/recipe\/(\d+)-/

/** The IDs in the block "Похожие" (a `<p>` in a `<header>` of a `<nav>`), without duplicates, in page order. */
export const extractSimilarIds = (document: Node): ReadonlyArray<number> => {
  const label = findByOwnText(document, "Похожие", new Set(["p"]))
  const header = label?.parentNode
  const block =
    header !== null && header !== undefined && isElement(header) && header.tagName === "header"
      ? header.parentNode
      : null
  if (block === null) {
    return []
  }
  const ids = findAll(block, byTag("a"))
    .map((anchor) => Number(RECIPE_LINK.exec(attr(anchor, "href") ?? "")?.[1]))
    .filter((id) => Number.isInteger(id) && id > 0)
  return [...new Set(ids)]
}
