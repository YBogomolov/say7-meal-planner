import { SESSION_IDS } from "../domain/household.ts"
import type { ShoppingAmount, ShoppingItem, ShoppingList } from "../domain/shopping-list.ts"
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

const recipesText = (item: ShoppingItem): string => ` (блюда: ${item.recipeIds.join(", ")})`

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

const dishesSection = (list: ShoppingList): ReadonlyArray<string> =>
  list.dishes.length === 0 ? [] : [
    "## Блюда",
    "",
    ...SESSION_IDS.flatMap((session) => {
      const dishes = list.dishes.filter((dish) => dish.session === session)
      const first = dishes[0]
      return first === undefined ? [] : [
        `Сессия ${session}, ${dateLabel(list.weekStart, first.sessionDay)}:`,
        "",
        ...dishes.map((dish) =>
          `- [${escapeLinkText(dish.title)}](${dish.url}) (${dish.recipeId})${dish.scale === 1 ? "" : `, масштаб ×${formatNumber(dish.scale)}`}`
        ),
        ""
      ]
    })
  ]

const unknownSection = (list: ShoppingList): ReadonlyArray<string> =>
  list.unknownRecipeIds.length === 0 ? [] : [
    `**Внимание:** рецептов ${list.unknownRecipeIds.join(", ")} нет в каталоге. Их продукты не вошли в список.`,
    ""
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
    ...dishesSection(list)
  ].join("\n").replace(/\n*$/, "\n")
