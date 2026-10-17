import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { ItemsReportJson } from "../src/domain/items-report.ts"
import { ServingsReportJson } from "../src/domain/servings-report.ts"
import { WeekPlanJson } from "../src/domain/week-plan.ts"
import { baseFiles, basePlan, BASE_COOKING, BASE_MEALS, planOf, withTempDir, writeFiles } from "./support/planner.ts"

/** The real commands `src/planner/plan-cli.ts` and `src/planner/items-cli.ts`, in a child process, on a temporary directory. */

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))
const PLAN_CLI = fileURLToPath(new URL("../src/planner/plan-cli.ts", import.meta.url))
const ITEMS_CLI = fileURLToPath(new URL("../src/planner/items-cli.ts", import.meta.url))
const SERVINGS_CLI = fileURLToPath(new URL("../src/planner/servings-cli.ts", import.meta.url))
const SHOPPING_TEXT_CLI = fileURLToPath(new URL("../src/planner/shopping-text-cli.ts", import.meta.url))
const SLOW_TEST_MS = 90_000

interface Finished {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const run = (script: string, args: ReadonlyArray<string>, cwd: string): Effect.Effect<Finished> =>
  Effect.promise(
    () =>
      new Promise<Finished>((resolve) => {
        execFile(TSX, [script, ...args], { cwd, timeout: 80_000 }, (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1
          resolve({ code, stdout, stderr })
        })
      })
  )

const encode = (plan: unknown) => JSON.stringify(plan)

describe("npm run plan:check, as a child process", () => {
  it.live(
    "prints the evaluation and the shopping list, and exits 0 for a plan without errors",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          yield* writeFiles(root, {
            ...baseFiles(),
            "plan.json": Schema.encodeSync(WeekPlanJson)(basePlan()),
          })
          const result = yield* run(PLAN_CLI, ["plan.json"], root)
          assert.strictEqual(result.code, 0, result.stderr)
          assert.include(result.stdout, "Каталог: 7 рецептов, пропущено 0. Сохранённых планов: 0.")
          assert.include(result.stdout, "План недели с 2026-10-17: ошибок нет, предупреждений: 0.")
          assert.include(result.stdout, "продуктов к покупке: 14")
          assert.include(result.stdout, "# Список покупок: неделя с 2026-10-17")
          assert.include(result.stdout, "- [ ] куриное филе — 900 г (блюда: 1, 7)")
          assert.include(result.stdout, "заморозить в день покупки, разморозить в холодильнике накануне сессии B")
        })
      ),
    SLOW_TEST_MS
  )

  it.live(
    "exits 1 and lists every error, and also prints the shopping list, for a plan with errors",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          const plan = planOf({
            cooking: [...BASE_COOKING, { session: "A", recipeId: 99 }],
            meals: BASE_MEALS.slice(0, 12),
          })
          yield* writeFiles(root, {
            ...baseFiles(),
            "plan.json": Schema.encodeSync(WeekPlanJson)(plan),
          })
          const result = yield* run(PLAN_CLI, ["plan.json"], root)
          assert.strictEqual(result.code, 1)
          assert.include(result.stdout, "ошибок: 3")
          assert.include(result.stdout, "[slot_missing]")
          assert.include(result.stdout, "[cooked_not_eaten]")
          assert.include(result.stdout, "Внимание:** рецептов 99 нет в каталоге")
          assert.include(result.stdout, "# Список покупок")
        })
      ),
    SLOW_TEST_MS
  )

  it.live(
    "reads the config and the saved plans of the directories",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          yield* writeFiles(root, {
            ...baseFiles(),
            "plan.json": Schema.encodeSync(WeekPlanJson)(basePlan()),
            "data/plans/2026-10-10.json": Schema.encodeSync(WeekPlanJson)({
              ...basePlan(),
              weekStart: "2026-10-10",
            }),
            "settings/household.json": '{"persons": 5}',
          })
          const result = yield* run(PLAN_CLI, ["plan.json", "--config-dir", "settings"], root)
          assert.strictEqual(result.code, 1)
          assert.include(result.stdout, "Сохранённых планов: 1.")
          assert.include(result.stdout, "[recent_repeat]")
          assert.include(result.stdout, "[portions_short]")
          assert.notInclude(result.stdout, "[portions_tight]")
        })
      ),
    SLOW_TEST_MS
  )

  it.live(
    "exits 1 with a message for a plan that is not valid, and 2 for wrong arguments",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          yield* writeFiles(root, {
            ...baseFiles(),
            "bad.json": encode({
              weekStart: "2026-02-30",
              cooking: [],
              meals: [],
            }),
            "text.json": "{",
          })
          const invalid = yield* run(PLAN_CLI, ["bad.json"], root)
          assert.strictEqual(invalid.code, 1)
          assert.include(invalid.stderr, "План не прошёл проверку")
          assert.include(invalid.stderr, "weekStart")
          const notJson = yield* run(PLAN_CLI, ["text.json"], root)
          assert.strictEqual(notJson.code, 1)
          const missing = yield* run(PLAN_CLI, ["nothing.json"], root)
          assert.strictEqual(missing.code, 1)
          assert.include(missing.stderr, "не читается")
          const usage = yield* run(PLAN_CLI, [], root)
          assert.strictEqual(usage.code, 2)
          assert.include(usage.stderr, "Missing required argument: файл")
          const help = yield* run(PLAN_CLI, ["--help"], root)
          assert.strictEqual(help.code, 0)
          assert.include(help.stdout, "plan:check")
        })
      ),
    SLOW_TEST_MS
  )

  it.live(
    "exits 1 and names the command if there are no enriched files",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          yield* writeFiles(root, {
            "data/parsed/1.json": "{}",
            "plan.json": Schema.encodeSync(WeekPlanJson)(basePlan()),
          })
          const result = yield* run(PLAN_CLI, ["plan.json"], root)
          assert.strictEqual(result.code, 1)
          assert.include(result.stderr, "npm run enrich")
        })
      ),
    SLOW_TEST_MS
  )
})

describe("npm run shopping:text, as a child process", () => {
  it.live(
    "prints only the text of the saved plan, one line per item, and the warnings to stderr",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          yield* writeFiles(root, {
            ...baseFiles(),
            "data/plans/2026-10-17.json": Schema.encodeSync(WeekPlanJson)(basePlan()),
            "config/servings-overrides.json": '{"99": {"min": 1, "max": 1}}',
          })
          const result = yield* run(SHOPPING_TEXT_CLI, ["2026-10-17"], root)
          assert.strictEqual(result.code, 0, result.stderr)
          assert.include(result.stdout, "куриное филе — 900 г\n")
          assert.notInclude(result.stdout, "(блюда:")
          assert.notInclude(result.stdout, "#")
          assert.notInclude(result.stdout, "Каталог:")
          assert.isTrue(result.stdout.endsWith("\n") && !result.stdout.endsWith("\n\n"))
          assert.include(result.stderr, "рецепт 99")
        })
      ),
    SLOW_TEST_MS
  )

  it.live(
    "exits 1 with a Russian message for a missing plan, and 2 for a bad date",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          yield* writeFiles(root, baseFiles())
          const missing = yield* run(SHOPPING_TEXT_CLI, ["2026-10-17"], root)
          assert.strictEqual(missing.code, 1)
          assert.strictEqual(missing.stdout, "")
          assert.include(missing.stderr, "План на неделю 2026-10-17 не найден")
          const badDate = yield* run(SHOPPING_TEXT_CLI, ["2026-13-01"], root)
          assert.strictEqual(badDate.code, 2)
          assert.include(badDate.stderr, "ГГГГ-ММ-ДД")
          const help = yield* run(SHOPPING_TEXT_CLI, ["--help"], root)
          assert.strictEqual(help.code, 0)
          assert.include(help.stdout, "shopping:text")
        })
      ),
    SLOW_TEST_MS
  )

  it.live(
    "adds the optional items with --with-optional",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          yield* writeFiles(root, {
            ...baseFiles(),
            "data/plans/2026-10-17.json": Schema.encodeSync(WeekPlanJson)(basePlan()),
          })
          const plain = yield* run(SHOPPING_TEXT_CLI, ["2026-10-17"], root)
          const optional = yield* run(SHOPPING_TEXT_CLI, ["2026-10-17", "--with-optional"], root)
          assert.strictEqual(optional.code, 0, optional.stderr)
          assert.isTrue(optional.stdout.startsWith(plain.stdout))
          assert.strictEqual(
            optional.stdout.slice(plain.stdout.length),
            "ванилин — 1 щепотка\nсыр — 100 г\nукроп — 1 пучок\n"
          )
        })
      ),
    SLOW_TEST_MS
  )
})

describe("npm run items:report, as a child process", () => {
  it.live(
    "writes data/items-report.json with the aliases of the config applied",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          yield* writeFiles(root, {
            ...baseFiles(),
            "config/item-aliases.json": '{"куриные бёдра": "куриное филе"}',
            "config/item-protein.json": '{"Куриные бёдра": 20}',
          })
          const result = yield* run(ITEMS_CLI, [], root)
          assert.strictEqual(result.code, 0, result.stderr)
          assert.include(result.stdout, "Каталог: 7 рецептов. Пропущено: 0.")
          assert.include(result.stdout, "Псевдонимов в config: 1.")
          const report = Schema.decodeUnknownSync(ItemsReportJson)(
            yield* fs.readFileString(`${root}/data/items-report.json`)
          )
          assert.strictEqual(report.recipes, 7)
          const chicken = report.items.find((row) => row.item === "куриное филе")
          assert.deepStrictEqual(chicken, {
            item: "куриное филе",
            recipes: 3,
            variants: ["куриное филе", "куриные бёдра"],
          })
          // Most recipes first, and the alphabet for a tie.
          assert.deepStrictEqual(
            report.items.slice(0, 2).map((row) => row.item),
            ["куриное филе", "лук репчатый"]
          )
          assert.isFalse(report.items.some((row) => row.item === "куриные бедра"))
          assert.notInclude(report.missingProtein, "куриное филе")
          assert.include(report.missingProtein, "лук репчатый")
          assert.include(result.stdout, `Продуктов без записи в item-protein.json: ${report.missingProtein.length}`)
        })
      ),
    SLOW_TEST_MS
  )

  it.live(
    "exits 1 and names the command if the data are missing, and 2 for an unknown option",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          const missing = yield* run(ITEMS_CLI, [], root)
          assert.strictEqual(missing.code, 1)
          assert.include(missing.stderr, "npm run parse")
          const usage = yield* run(ITEMS_CLI, ["--fast"], root)
          assert.strictEqual(usage.code, 2)
        })
      ),
    SLOW_TEST_MS
  )
})

describe("npm run servings:report, as a child process", () => {
  it.live(
    "writes data/servings-report.json and warns about an unknown override",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          yield* writeFiles(root, {
            ...baseFiles(),
            "config/servings-overrides.json": '{"1": {"min": 20, "max": 30}, "99": {"min": 1, "max": 1}}',
          })
          const result = yield* run(SERVINGS_CLI, [], root)
          assert.strictEqual(result.code, 0, result.stderr)
          assert.include(result.stderr, "рецепт 99")
          assert.include(result.stdout, "Переопределений порций: 1.")
          const report = Schema.decodeUnknownSync(ServingsReportJson)(
            yield* fs.readFileString(`${root}/data/servings-report.json`)
          )
          assert.strictEqual(report.recipes, 7)
          const first = report.entries.find((entry) => Number(entry.id) === 1)
          assert.isTrue(first?.overridden)
          assert.include(first?.reasons, "max_above_12")
        })
      ),
    SLOW_TEST_MS
  )

  it.live(
    "exits 1 if the data are missing, and 2 for an unknown option",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* run(SERVINGS_CLI, [], root)).code, 1)
          assert.strictEqual((yield* run(SERVINGS_CLI, ["--fast"], root)).code, 2)
        })
      ),
    SLOW_TEST_MS
  )
})
