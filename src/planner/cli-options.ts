import { Result, Schema } from "effect"
import { parseArgs } from "node:util"
import { CliError } from "../scraper/cli-options.ts"
import { DEFAULT_CONFIG_DIR, DEFAULT_DATA_DIR } from "./config.ts"

export const ITEMS_REPORT_USAGE = `Использование: npm run items:report -- [параметры]

Читает каталог (<data-dir>/parsed и <data-dir>/enriched) и пишет <data-dir>/items-report.json:
каждый нормализованный продукт с числом рецептов и написаниями из рецептов.
По этому файлу заполняют config/item-aliases.json.

Параметры:
  --data-dir <путь>    Каталог с данными (по умолчанию ${DEFAULT_DATA_DIR}).
  --config-dir <путь>  Каталог с настройками (по умолчанию ${DEFAULT_CONFIG_DIR}).
  -h, --help           Показать этот текст.`

export const PLAN_CHECK_USAGE = `Использование: npm run plan:check -- <файл> [параметры]

Проверяет план недели (JSON, форма WeekPlan) по правилам семьи
и печатает оценку плана и список покупок в Markdown.
Код выхода 1, если в плане есть ошибки.

Параметры:
  --data-dir <путь>    Каталог с данными: parsed, enriched, plans (по умолчанию ${DEFAULT_DATA_DIR}).
  --config-dir <путь>  Каталог с настройками (по умолчанию ${DEFAULT_CONFIG_DIR}).
  -h, --help           Показать этот текст.`

export interface ItemsReportOptions {
  readonly dataDir: string
  readonly configDir: string
}

export interface PlanCheckOptions extends ItemsReportOptions {
  /** The file with the plan. */
  readonly file: string
}

export type ItemsReportCommand =
  | { readonly _tag: "Help" }
  | { readonly _tag: "Run"; readonly options: ItemsReportOptions }

export type PlanCheckCommand =
  | { readonly _tag: "Help" }
  | { readonly _tag: "Run"; readonly options: PlanCheckOptions }

const CliArgs = Schema.Struct({
  help: Schema.optional(Schema.Boolean),
  "data-dir": Schema.optional(Schema.NonEmptyString),
  "config-dir": Schema.optional(Schema.NonEmptyString)
})

const readArgs = (argv: ReadonlyArray<string>, allowPositionals: boolean) =>
  Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        options: {
          "data-dir": { type: "string" },
          "config-dir": { type: "string" },
          help: { type: "boolean", short: "h" }
        },
        allowPositionals,
        strict: true
      }),
    catch: (cause) => new CliError({ message: cause instanceof Error ? cause.message : String(cause) })
  }).pipe(
    Result.flatMap((parsed) =>
      Schema.decodeUnknownResult(CliArgs)(parsed.values).pipe(
        Result.map((args) => ({ args, positionals: parsed.positionals })),
        Result.mapError((error) => new CliError({ message: `Неверный параметр.\n${error.message}` }))
      )
    )
  )

/** Parse the command line of `npm run items:report` (`process.argv.slice(2)`). */
export const parseItemsReportCli = (argv: ReadonlyArray<string>): Result.Result<ItemsReportCommand, CliError> =>
  readArgs(argv, false).pipe(
    Result.map(({ args }): ItemsReportCommand =>
      args.help === true ? { _tag: "Help" } : {
        _tag: "Run",
        options: { dataDir: args["data-dir"] ?? DEFAULT_DATA_DIR, configDir: args["config-dir"] ?? DEFAULT_CONFIG_DIR }
      }
    )
  )

/** Parse the command line of `npm run plan:check`: 1 file and the options. */
export const parsePlanCheckCli = (argv: ReadonlyArray<string>): Result.Result<PlanCheckCommand, CliError> =>
  readArgs(argv, true).pipe(
    Result.flatMap(({ args, positionals }): Result.Result<PlanCheckCommand, CliError> => {
      if (args.help === true) {
        return Result.succeed({ _tag: "Help" })
      }
      const [file, ...rest] = positionals
      if (file === undefined || rest.length > 0) {
        return Result.fail(new CliError({ message: "Укажите ровно один файл с планом." }))
      }
      return Result.succeed({
        _tag: "Run",
        options: { file, dataDir: args["data-dir"] ?? DEFAULT_DATA_DIR, configDir: args["config-dir"] ?? DEFAULT_CONFIG_DIR }
      })
    })
  )
