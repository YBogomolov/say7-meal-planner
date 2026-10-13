import type { Catalogue } from "../domain/catalogue.ts"
import type { Household } from "../domain/household.ts"
import type { PlanEvaluation, PlanIssue } from "../domain/plan-evaluation.ts"
import type { RecipeId } from "../domain/recipe.ts"
import type { ShoppingList } from "../domain/shopping-list.ts"
import type { WeekPlan } from "../domain/week-plan.ts"
import { dateLabel, formatNumber, MEAL_LABELS, PROTEIN_LABELS } from "./labels.ts"
import { escapeLinkText, renderShoppingList } from "./shopping-render.ts"

export interface MenuInput {
  readonly plan: WeekPlan
  readonly catalogue: Catalogue
  readonly household: Household
  readonly evaluation: PlanEvaluation
  readonly list: ShoppingList
}

/** A dish as a Markdown link. A recipe that the catalogue does not know is a plain note. The recipe text is never here (spec D6). */
const dishLink = (catalogue: Catalogue, id: RecipeId): string => {
  const entry = catalogue.byId.get(id)
  return entry === undefined ? `рецепт ${id} (нет в каталоге)` : `[${escapeLinkText(entry.title)}](${entry.url})`
}

const tableCell = (text: string): string => text.replaceAll("|", "\\|")

const tableSection = ({ plan, catalogue, household }: MenuInput): ReadonlyArray<string> => {
  const days = Array.from({ length: household.days }, (_, day) => day)
  return [
    "## Меню по дням",
    "",
    `| День | ${household.meals.map((meal) => MEAL_LABELS[meal]).join(" | ")} |`,
    `| --- |${household.meals.map(() => " --- |").join("")}`,
    ...days.map((day) => {
      const cells = household.meals.map((meal) => {
        const slot = plan.meals.find((entry) => entry.day === day && entry.meal === meal)
        return slot === undefined || slot.recipeIds.length === 0
          ? "—"
          : tableCell(slot.recipeIds.map((id) => dishLink(catalogue, id)).join(" + "))
      })
      return `| ${dateLabel(plan.weekStart, day)} | ${cells.join(" | ")} |`
    }),
    ""
  ]
}

const sessionsSection = ({ plan, catalogue, household, evaluation }: MenuInput): ReadonlyArray<string> => [
  "## Сессии готовки",
  "",
  ...household.sessions.flatMap((session) => {
    const dishes = plan.cooking.filter((entry) => entry.session === session.id)
    const minutes = evaluation.metrics.activeMinutes.find((item) => item.session === session.id)?.minutes ?? 0
    return [
      `### Сессия ${session.id}: ${dateLabel(plan.weekStart, session.dayOffset)}`,
      "",
      ...(dishes.length === 0
        ? ["Блюд нет."]
        : dishes.map((entry) => {
          const active = catalogue.byId.get(entry.recipeId)?.enrichment.activeMinutes
          const facts = [
            `масштаб ×${formatNumber(entry.scale)}`,
            ...(active === undefined ? [] : [`активно ${formatNumber(active)} мин.`])
          ]
          return `- ${dishLink(catalogue, entry.recipeId)}: ${facts.join(", ")}`
        })),
      "",
      `Активное время сессии: ${formatNumber(minutes)} мин. (норма ${formatNumber(household.activeMinutesPerSession)} мин.).`,
      ""
    ]
  })
]

const issueBlock = (heading: string, issues: ReadonlyArray<PlanIssue>): ReadonlyArray<string> =>
  issues.length === 0 ? [] : [`${heading}:`, "", ...issues.map((issue) => `- [${issue.code}] ${issue.message}`), ""]

const evaluationSection = ({ evaluation }: MenuInput): ReadonlyArray<string> => {
  const { errors, warnings, metrics } = evaluation
  const families = metrics.proteinFamilies.map((family) => PROTEIN_LABELS[family]).join(", ")
  return [
    "## Оценка плана",
    "",
    `Итог: ${evaluation.ok ? "ошибок нет" : `ошибок: ${errors.length}`}, предупреждений: ${warnings.length}.`,
    "",
    `- Продуктов к покупке: ${metrics.buyItemCount}. Продуктов из запасов дома: ${metrics.pantryItemCount}.`,
    `- Блюд: ${metrics.dishCount}. Приёмов пищи заполнено: ${metrics.slotsCovered} из ${metrics.slotsRequired}.`,
    `- Белок: ${families === "" ? "нет" : families}.`,
    "",
    ...issueBlock("Ошибки", errors),
    ...issueBlock("Предупреждения", warnings)
  ]
}

/** Move every heading of a Markdown text one level down, so the text fits under a `##` heading. */
const demoteHeadings = (markdown: string): string => markdown.replace(/^(#+) /gm, "#$1 ")

/**
 * The menu of a week as Markdown in Russian (handoff T4.4). Pure.
 * Parts: the table days × meals with links, a section for each cooking session, the evaluation, the shopping list.
 * The menu has titles and links only: the recipe texts stay on the site (spec D6).
 */
export const renderMenu = (input: MenuInput): string => {
  const { plan } = input
  return [
    `# Меню недели с ${plan.weekStart}`,
    "",
    ...(plan.notes === null || plan.notes.trim() === "" ? [] : [plan.notes.trim(), ""]),
    ...tableSection(input),
    ...sessionsSection(input),
    ...evaluationSection(input),
    demoteHeadings(renderShoppingList(input.list))
  ].join("\n").replace(/\n*$/, "\n")
}
