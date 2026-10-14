import { SESSION_IDS } from "../domain/household.ts"
import type { ShoppingAmount, ShoppingDish, ShoppingItem, ShoppingList } from "../domain/shopping-list.ts"
import { CATEGORY_HEADINGS, dateLabel, formatAmount, formatNumber } from "./labels.ts"

/** Pieces first, then grams (see `shopperUnits`): `8 шт. (≈ 413 г)`. */
const piecesWithGrams = (amounts: ReadonlyArray<ShoppingAmount>): string | undefined => {
  const [pieces, grams, ...rest] = amounts
  return pieces?.unit === "pcs" && grams?.unit === "g" && rest.length === 0
    ? `${formatAmount(pieces.unit, pieces.value)} (≈ ${formatAmount(grams.unit, grams.value)})`
    : undefined
}

const amountsText = (amounts: ReadonlyArray<ShoppingAmount>, approximate: boolean): string => {
  if (amounts.length === 0) {
    return ""
  }
  const pieces = piecesWithGrams(amounts)
  return pieces === undefined
    ? ` — ${approximate ? "≈ " : ""}${amounts.map((amount) => formatAmount(amount.unit, amount.value)).join(" + ")}`
    : ` — ${pieces}`
}

/** The dishes that use the item, and the simple breakfasts: ` (блюда: 1, 2; завтраки: tvorog-yagody)`. */
const recipesText = (item: ShoppingItem): string => {
  const parts = [
    ...(item.recipeIds.length === 0 ? [] : [`блюда: ${item.recipeIds.join(", ")}`]),
    ...(item.simpleIds.length === 0 ? [] : [`завтраки: ${item.simpleIds.join(", ")}`])
  ]
  return ` (${parts.join("; ")})`
}

/** The text of a link in Markdown: the brackets and the backslash get a backslash. */
export const escapeLinkText = (text: string): string => text.replace(/[\\[\]]/g, (char) => `\\${char}`)

const buySection = (list: ShoppingList): ReadonlyArray<string> => [
  "## Купить",
  "",
  ...(list.buy.length === 0 ? ["Покупать нечего."] : list.buy.flatMap(({ category, items }) => [
    `### ${CATEGORY_HEADINGS[category]}`,
    "",
    ...items.map((item) => `- [ ] ${item.item}${amountsText(item.amounts, item.approximate)}${recipesText(item)}`),
    ""
  ]))
]

const freezeSection = (list: ShoppingList): ReadonlyArray<string> =>
  list.actions.length === 0 ? [] : [
    "## Заморозка",
    "",
    ...list.actions.map((action) =>
      `- **${action.item}**${amountsText(action.amounts, false)} для сессии ${action.session} (блюда: ${action.recipeIds.join(", ")}): ${action.text}.`
    ),
    ""
  ]

const plainSection = (heading: string, items: ReadonlyArray<ShoppingItem>, withRecipes: boolean): ReadonlyArray<string> =>
  items.length === 0 ? [] : [
    `## ${heading}`,
    "",
    ...items.map((item) => `- ${item.item}${amountsText(item.amounts, item.approximate)}${withRecipes ? recipesText(item) : ""}`),
    ""
  ]

const dishLine = (dish: ShoppingDish): string =>
  `- [${escapeLinkText(dish.title)}](${dish.url}) (${dish.recipeId})${dish.scale === 1 ? "" : `, масштаб ×${formatNumber(dish.scale)}`}`

/** Fresh dishes (spec P7.2.2): the days of cooking, and the scale of one day. */
const freshDishes = (list: ShoppingList): ReadonlyArray<string> => {
  const dishes = list.dishes.filter((dish) => dish.session === "fresh")
  return dishes.length === 0 ? [] : [
    "Свежие блюда, утром в день еды:",
    "",
    ...dishes.map((dish) => `${dishLine(dish)}, дни ${dish.freshDays.join(", ")}`),
    ""
  ]
}

/** Simple breakfasts (spec P7.2.3): the title, the portions and the days. */
const simpleSection = (list: ShoppingList): ReadonlyArray<string> =>
  list.simpleBreakfasts.length === 0 ? [] : [
    "## Простые завтраки",
    "",
    ...list.simpleBreakfasts.map((simple) =>
      `- ${simple.title} (${simple.id}): ${formatNumber(simple.portions)} порц., дни ${simple.days.join(", ")}`
    ),
    ""
  ]

const dishesSection = (list: ShoppingList): ReadonlyArray<string> =>
  list.dishes.length === 0 ? [] : [
    "## Блюда",
    "",
    ...SESSION_IDS.flatMap((session) => {
      const dishes = list.dishes.filter((dish) => dish.session === session)
      const first = dishes[0]
      return first === undefined || first.sessionDay === null ? [] : [
        `Сессия ${session}, ${dateLabel(list.weekStart, first.sessionDay)}:`,
        "",
        ...dishes.map(dishLine),
        ""
      ]
    }),
    ...freshDishes(list)
  ]

const unknownSection = (list: ShoppingList): ReadonlyArray<string> => [
  ...(list.unknownRecipeIds.length === 0 ? [] : [
    `**Внимание:** рецептов ${list.unknownRecipeIds.join(", ")} нет в каталоге. Их продукты не вошли в список.`,
    ""
  ]),
  ...(list.unknownSimpleIds.length === 0 ? [] : [
    `**Внимание:** простых завтраков ${list.unknownSimpleIds.join(", ")} нет в config/simple-breakfasts.json. Их продукты не вошли в список.`,
    ""
  ])
]

/**
 * The shopping list as Markdown in Russian (spec P4.5.6). Units: г, кг (from 1000 г), мл, л (from 1000 мл), шт. and the rest.
 * The decimal separator is a comma.
 */
export const renderShoppingList = (list: ShoppingList): string =>
  [
    `# Список покупок: неделя с ${list.weekStart}`,
    "",
    `День покупки: ${dateLabel(list.weekStart, list.shoppingDay)} (день ${list.shoppingDay}).`,
    "",
    ...unknownSection(list),
    ...buySection(list),
    ...freezeSection(list),
    ...plainSection("По желанию", list.optional, true),
    ...plainSection("Проверить дома", list.check_at_home, false),
    ...dishesSection(list),
    ...simpleSection(list)
  ].join("\n").replace(/\n*$/, "\n")

const textLine = (item: ShoppingItem): string => `${item.item}${amountsText(item.amounts, item.approximate)}\n`

/**
 * The shopping list as plain text, for a checklist note (spec P4.5.8): 1 line per item of `buy` in shop order,
 * then the optional items if `withOptional`. No headings, no recipe IDs. Each line ends with 1 newline.
 */
export const renderShoppingText = (list: ShoppingList, options: { readonly withOptional: boolean }): string =>
  [
    ...list.buy.flatMap(({ items }) => items.map(textLine)),
    ...(options.withOptional ? list.optional.map(textLine) : [])
  ].join("")
