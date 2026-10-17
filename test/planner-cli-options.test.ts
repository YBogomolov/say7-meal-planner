import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  makeItemsReportCommand,
  makePlanCheckCommand,
  makeServingsReportCommand,
  makeShoppingTextCommand,
} from "../src/planner/cli-options.ts"
import type { ItemsReportOptions, PlanCheckOptions, ShoppingTextOptions } from "../src/planner/cli-options.ts"
import { formatEvaluation } from "../src/planner/report.ts"
import { evaluatePlan } from "../src/planner/evaluate.ts"
import { DEFAULT_HOUSEHOLD } from "../src/domain/household.ts"
import { baseCatalogue, basePlan, BASE_COOKING, BASE_MEALS, planOf } from "./support/planner.ts"
import { commandTester } from "./support/cli.ts"
import { readFileSync } from "node:fs"

const planCheck = commandTester<PlanCheckOptions>()(makePlanCheckCommand)
const itemsReport = commandTester<ItemsReportOptions>()(makeItemsReportCommand)
const servingsReport = commandTester<ItemsReportOptions>()(makeServingsReportCommand)
const shoppingText = commandTester<ShoppingTextOptions>()(makeShoppingTextCommand)

describe("plan:check command", () => {
  it.effect("takes 1 file and the defaults of the directories", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* planCheck.parsed(["plan.json"]), {
        file: "plan.json",
        dataDir: "data",
        configDir: "config",
      })
    })
  )

  it.effect("takes the directories", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* planCheck.parsed(["--data-dir", "d", "p.json", "--config-dir", "c"]), {
        file: "p.json",
        dataDir: "d",
        configDir: "c",
      })
    })
  )

  it.effect("shows the help", () =>
    Effect.gen(function* () {
      const long = yield* planCheck.help(["--help"])
      assert.strictEqual(yield* planCheck.help(["-h"]), long)
      assert.include(long, "plan:check")
      assert.include(long, "--data-dir")
      assert.include(long, "--config-dir")
    })
  )

  it.effect.each([
    { argv: [] },
    { argv: ["a.json", "b.json"] },
    { argv: ["a.json", "--limit", "3"] },
    { argv: ["a.json", "--data-dir", ""] },
    { argv: ["a.json", "--data-dir"] },
  ])("rejects no file, 2 files, an unknown option and an empty directory: %j", ({ argv }) => planCheck.rejection(argv))
})

describe("items:report command", () => {
  it.effect("takes the defaults and the directories", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* itemsReport.parsed([]), { dataDir: "data", configDir: "config" })
      assert.deepStrictEqual(yield* itemsReport.parsed(["--data-dir", "x", "--config-dir", "y"]), {
        dataDir: "x",
        configDir: "y",
      })
    })
  )

  it.effect("rejects a file, and an unknown option", () =>
    Effect.gen(function* () {
      yield* itemsReport.rejection(["plan.json"])
      yield* itemsReport.rejection(["--force"])
      yield* itemsReport.rejection(["--with-optional"])
    })
  )

  it.effect("shows the help", () =>
    Effect.gen(function* () {
      const text = yield* itemsReport.help()
      assert.include(text, "items:report")
      assert.include(text, "--data-dir")
      assert.include(text, "--config-dir")
    })
  )
})

describe("servings:report command", () => {
  it.effect("takes the same options as items:report", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* servingsReport.parsed([]), { dataDir: "data", configDir: "config" })
      assert.deepStrictEqual(yield* servingsReport.parsed(["--config-dir", "y"]), {
        dataDir: "data",
        configDir: "y",
      })
      yield* servingsReport.rejection(["plan.json"])
      assert.include(yield* servingsReport.help(), "servings:report")
    })
  )
})

describe("shopping:text command", () => {
  it.effect("takes the week start and the defaults", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* shoppingText.parsed(["2026-10-17"]), {
        weekStart: "2026-10-17",
        withOptional: false,
        dataDir: "data",
        configDir: "config",
      })
    })
  )

  it.effect("takes --with-optional and the directories, in any order", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* shoppingText.parsed(["--with-optional", "2026-10-17", "--data-dir", "d", "--config-dir", "c"]),
        {
          weekStart: "2026-10-17",
          withOptional: true,
          dataDir: "d",
          configDir: "c",
        }
      )
    })
  )

  it.effect("shows the help", () =>
    Effect.gen(function* () {
      const text = yield* shoppingText.help(["-h"])
      assert.include(text, "shopping:text")
      assert.include(text, "--with-optional")
    })
  )

  it.effect.each([
    { argv: [] },
    { argv: ["2026-10-17", "2026-10-24"] },
    { argv: ["2026-02-30"] },
    { argv: ["17.10.2026"] },
    { argv: ["2026-10-17", "--force"] },
    { argv: ["2026-10-17", "--data-dir"] },
  ])("rejects no date, 2 positionals, a date that is not a real day, and an unknown option: %j", ({ argv }) =>
    shoppingText.rejection(argv)
  )

  it.effect("explains a date that is not a real day", () =>
    Effect.gen(function* () {
      assert.include(yield* shoppingText.rejection(["2026-02-30"]), "ГГГГ-ММ-ДД")
    })
  )
})

describe("package.json", () => {
  it("has the scripts of the planner commands", () => {
    const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts
    assert.strictEqual(scripts["items:report"], "tsx src/planner/items-cli.ts")
    assert.strictEqual(scripts["plan:check"], "tsx src/planner/plan-cli.ts")
    assert.strictEqual(scripts["shopping:text"], "tsx src/planner/shopping-text-cli.ts")
  })
})

describe("formatEvaluation", () => {
  it("says that there are no errors, and gives the metrics", () => {
    const text = formatEvaluation("2026-10-17", evaluatePlan(basePlan(), baseCatalogue(), DEFAULT_HOUSEHOLD, []))
    assert.strictEqual(
      text,
      [
        "План недели с 2026-10-17: ошибок нет, предупреждений: 0.",
        "",
        "Показатели:",
        "  - продуктов к покупке: 14; продуктов из запасов дома: 4",
        "  - блюд: 7; приёмов пищи заполнено: 14 из 14",
        "  - белок: курица",
        "  - белок на порцию по приёмам пищи: обед 0–0 г; ужин 0–0 г",
        "  - активное время: сессия A — 80 мин.; сессия B — 60 мин.",
        "",
      ].join("\n")
    )
  })

  it("lists the errors and the warnings with their codes", () => {
    const plan = planOf({
      cooking: BASE_COOKING.filter((entry) => entry.recipeId !== 4),
      meals: BASE_MEALS.slice(0, 13),
    })
    const catalogue = baseCatalogue({ 2: { enrichment: { heat: 2 } } })
    const text = formatEvaluation(plan.weekStart, evaluatePlan(plan, catalogue, DEFAULT_HOUSEHOLD, []))
    assert.include(text, "ошибок: 2, предупреждений: 1.")
    assert.include(text, "Ошибки (2):\n  - [not_cooked] ")
    assert.include(text, "  - [slot_missing] Не заполнен слот: день 6 (пятница), ужин.")
    assert.include(text, "Предупреждения (1):\n  - [heat] ")
  })
})
