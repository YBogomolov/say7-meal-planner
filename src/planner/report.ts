import type { PlanEvaluation, PlanIssue } from "../domain/plan-evaluation.ts"
import type { IsoDate } from "../domain/recipe.ts"
import { formatNumber, PROTEIN_LABELS } from "./labels.ts"

const issueLine = (issue: PlanIssue): string => `  - [${issue.code}] ${issue.message}`

const issueBlock = (heading: string, issues: ReadonlyArray<PlanIssue>): ReadonlyArray<string> =>
  issues.length === 0 ? [] : [`${heading} (${issues.length}):`, ...issues.map(issueLine), ""]

/** The evaluation of a plan as Russian text for the console (`npm run plan:check`). */
export const formatEvaluation = (weekStart: IsoDate, evaluation: PlanEvaluation): string => {
  const { errors, warnings, metrics } = evaluation
  const verdict = evaluation.ok ? "ошибок нет" : `ошибок: ${errors.length}`
  const families = metrics.proteinFamilies.map((family) => PROTEIN_LABELS[family]).join(", ")
  const minutes = metrics.activeMinutes.map(({ session, minutes: value }) => `сессия ${session} — ${formatNumber(value)} мин.`)
  return [
    `План недели с ${weekStart}: ${verdict}, предупреждений: ${warnings.length}.`,
    "",
    ...issueBlock("Ошибки", errors),
    ...issueBlock("Предупреждения", warnings),
    "Показатели:",
    `  - продуктов к покупке: ${metrics.buyItemCount}; продуктов из запасов дома: ${metrics.pantryItemCount}`,
    `  - блюд: ${metrics.dishCount}; приёмов пищи заполнено: ${metrics.slotsCovered} из ${metrics.slotsRequired}`,
    `  - белок: ${families === "" ? "нет" : families}`,
    `  - активное время: ${minutes.join("; ")}`,
    ""
  ].join("\n")
}
