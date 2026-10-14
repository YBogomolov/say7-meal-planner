import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { ITEMS_REPORT_USAGE, parseItemsReportCli, parsePlanCheckCli, parseShoppingTextCli, PLAN_CHECK_USAGE, SHOPPING_TEXT_USAGE } from "../src/planner/cli-options.ts"
import { formatEvaluation } from "../src/planner/report.ts"
import { evaluatePlan } from "../src/planner/evaluate.ts"
import { DEFAULT_HOUSEHOLD } from "../src/domain/household.ts"
import { baseCatalogue, basePlan, BASE_COOKING, BASE_MEALS, planOf } from "./support/planner.ts"
import { readFileSync } from "node:fs"

describe("parsePlanCheckCli", () => {
  it("takes 1 file and the defaults of the directories", () => {
    assert.deepStrictEqual(Result.getOrThrow(parsePlanCheckCli(["plan.json"])), {
      _tag: "Run",
      options: { file: "plan.json", dataDir: "data", configDir: "config" }
    })
  })

  it("takes the directories", () => {
    assert.deepStrictEqual(Result.getOrThrow(parsePlanCheckCli(["--data-dir", "d", "p.json", "--config-dir", "c"])), {
      _tag: "Run",
      options: { file: "p.json", dataDir: "d", configDir: "c" }
    })
  })

  it("shows the help", () => {
    assert.deepStrictEqual(Result.getOrThrow(parsePlanCheckCli(["--help"])), { _tag: "Help" })
    assert.deepStrictEqual(Result.getOrThrow(parsePlanCheckCli(["-h"])), { _tag: "Help" })
  })

  it("rejects no file, 2 files, an unknown option and an empty directory", () => {
    for (const argv of [[], ["a.json", "b.json"], ["a.json", "--limit", "3"], ["a.json", "--data-dir", ""], ["a.json", "--data-dir"]]) {
      const result = parsePlanCheckCli(argv)
      assert.isTrue(Result.isFailure(result), argv.join(" "))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "CliError")
      }
    }
    const none = parsePlanCheckCli([])
    assert.include(Result.isFailure(none) ? none.failure.message : "", "ровно один файл")
  })
})

describe("parseItemsReportCli", () => {
  it("takes the defaults and the directories", () => {
    assert.deepStrictEqual(Result.getOrThrow(parseItemsReportCli([])), {
      _tag: "Run",
      options: { dataDir: "data", configDir: "config" }
    })
    assert.deepStrictEqual(Result.getOrThrow(parseItemsReportCli(["--data-dir", "x", "--config-dir", "y"])), {
      _tag: "Run",
      options: { dataDir: "x", configDir: "y" }
    })
  })

  it("rejects a file, and an unknown option", () => {
    assert.isTrue(Result.isFailure(parseItemsReportCli(["plan.json"])))
    assert.isTrue(Result.isFailure(parseItemsReportCli(["--force"])))
  })

  it("shows the help", () => {
    assert.deepStrictEqual(Result.getOrThrow(parseItemsReportCli(["--help"])), { _tag: "Help" })
  })
})

describe("parseShoppingTextCli", () => {
  it("takes the week start and the defaults", () => {
    assert.deepStrictEqual(Result.getOrThrow(parseShoppingTextCli(["2026-10-17"])), {
      _tag: "Run",
      options: { weekStart: "2026-10-17", withOptional: false, dataDir: "data", configDir: "config" }
    })
  })

  it("takes --with-optional and the directories, in any order", () => {
    assert.deepStrictEqual(
      Result.getOrThrow(parseShoppingTextCli(["--with-optional", "2026-10-17", "--data-dir", "d", "--config-dir", "c"])),
      { _tag: "Run", options: { weekStart: "2026-10-17", withOptional: true, dataDir: "d", configDir: "c" } }
    )
  })

  it("shows the help", () => {
    assert.deepStrictEqual(Result.getOrThrow(parseShoppingTextCli(["-h"])), { _tag: "Help" })
  })

  it("rejects no date, 2 positionals, a date that is not a real day, and the option of another command", () => {
    for (const argv of [[], ["2026-10-17", "2026-10-24"], ["2026-02-30"], ["17.10.2026"], ["2026-10-17", "--force"], ["2026-10-17", "--data-dir"]]) {
      const result = parseShoppingTextCli(argv)
      assert.isTrue(Result.isFailure(result), argv.join(" "))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "CliError")
      }
    }
    const badDate = parseShoppingTextCli(["2026-02-30"])
    assert.include(Result.isFailure(badDate) ? badDate.failure.message : "", "ГГГГ-ММ-ДД")
    assert.isTrue(Result.isFailure(parseItemsReportCli(["--with-optional"])))
  })
})

describe("usage texts and package.json", () => {
  it("name the options that the parsers accept", () => {
    for (const text of [PLAN_CHECK_USAGE, ITEMS_REPORT_USAGE]) {
      assert.include(text, "--data-dir")
      assert.include(text, "--config-dir")
    }
    assert.include(PLAN_CHECK_USAGE, "npm run plan:check")
    assert.include(ITEMS_REPORT_USAGE, "npm run items:report")
    assert.include(SHOPPING_TEXT_USAGE, "npm run shopping:text")
    assert.include(SHOPPING_TEXT_USAGE, "--with-optional")
  })

  it("has the scripts items:report and plan:check", () => {
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
        ""
      ].join("\n")
    )
  })

  it("lists the errors and the warnings with their codes", () => {
    const plan = planOf({ cooking: BASE_COOKING.filter((entry) => entry.recipeId !== 4), meals: BASE_MEALS.slice(0, 13) })
    const catalogue = baseCatalogue({ 2: { enrichment: { heat: 2 } } })
    const text = formatEvaluation(plan.weekStart, evaluatePlan(plan, catalogue, DEFAULT_HOUSEHOLD, []))
    assert.include(text, "ошибок: 2, предупреждений: 1.")
    assert.include(text, "Ошибки (2):\n  - [not_cooked] ")
    assert.include(text, "  - [slot_missing] Не заполнен слот: день 6 (пятница), ужин.")
    assert.include(text, "Предупреждения (1):\n  - [heat] ")
  })
})
