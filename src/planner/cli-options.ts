import { Result, Schema } from "effect"
import { parseArgs } from "node:util"
import { CliError } from "../scraper/cli-options.ts"
import { isCalendarDate } from "../domain/calendar.ts"
import { DEFAULT_CONFIG_DIR, DEFAULT_DATA_DIR } from "./config.ts"

export const ITEMS_REPORT_USAGE = `Использование: npm run items:report -- [параметры]

Читает каталог (<data-dir>/parsed и <data-dir>/enriched) и пишет <data-dir>/items-report.json:
каждый нормализованный продукт с числом рецептов и написаниями из рецептов.
По этому файлу заполняют config/item-aliases.json.

Параметры:
  --data-dir <путь>    Каталог с данными (по умолчанию ${DEFAULT_DATA_DIR}).
  --config-dir <путь>  Каталог с настройками (по умолчанию ${DEFAULT_CONFIG_DIR}).
  -h, --help           Показать этот текст.`

export const SERVINGS_REPORT_USAGE = `Использование: npm run servings:report -- [параметры]

Читает каталог (<data-dir>/parsed и <data-dir>/enriched) и config/servings-overrides.json,
ищет рецепты с подозрительным числом порций и пишет <data-dir>/servings-report.json.
Рецепт попадает в отчёт, если порции оценены моделью, их больше 12, max больше 3 × min
или масса порции вне 150–700 г.

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

export const SHOPPING_TEXT_USAGE = `Использование: npm run shopping:text -- <дата начала недели> [параметры]

Читает план недели <data-dir>/plans/<дата начала недели>.json и печатает список покупок
простым текстом: одна строка на продукт, «продукт — количество». Без заголовков.
Текст идёт в stdout, предупреждения в stderr. Для буфера обмена на macOS:
  npm run -s shopping:text -- 2026-10-17 | pbcopy
Текст можно вставить в чек-лист заметки Google Keep.

Параметры:
  --with-optional      Добавить строки «по желанию» после покупок.
  --data-dir <путь>    Каталог с данными (по умолчанию ${DEFAULT_DATA_DIR}).
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

export interface ShoppingTextOptions extends ItemsReportOptions {
  /** The first day of the plan week, `YYYY-MM-DD`. */
  readonly weekStart: string
  /** Add the optional items after the items to buy. */
  readonly withOptional: boolean
}

export type ShoppingTextCommand =
  { readonly _tag: "Help" } | { readonly _tag: "Run"; readonly options: ShoppingTextOptions }

export type ItemsReportCommand =
  { readonly _tag: "Help" } | { readonly _tag: "Run"; readonly options: ItemsReportOptions }

export type PlanCheckCommand = { readonly _tag: "Help" } | { readonly _tag: "Run"; readonly options: PlanCheckOptions }

const CliArgs = Schema.Struct({
  help: Schema.optional(Schema.Boolean),
  "with-optional": Schema.optional(Schema.Boolean),
  "data-dir": Schema.optional(Schema.NonEmptyString),
  "config-dir": Schema.optional(Schema.NonEmptyString),
})

const readArgs = (argv: ReadonlyArray<string>, allowPositionals: boolean, withOptional = false) =>
  Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        options: {
          "data-dir": { type: "string" },
          "config-dir": { type: "string" },
          help: { type: "boolean", short: "h" },
          ...(withOptional ? { "with-optional": { type: "boolean" as const } } : {}),
        },
        allowPositionals,
        strict: true,
      }),
    catch: (cause) =>
      new CliError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
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
      args.help === true
        ? { _tag: "Help" }
        : {
            _tag: "Run",
            options: {
              dataDir: args["data-dir"] ?? DEFAULT_DATA_DIR,
              configDir: args["config-dir"] ?? DEFAULT_CONFIG_DIR,
            },
          }
    )
  )

/** Parse the command line of `npm run servings:report`: the same options as `items:report`. */
export const parseServingsReportCli = parseItemsReportCli

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
        options: {
          file,
          dataDir: args["data-dir"] ?? DEFAULT_DATA_DIR,
          configDir: args["config-dir"] ?? DEFAULT_CONFIG_DIR,
        },
      })
    })
  )

/** Parse the command line of `npm run shopping:text`: 1 week start date and the options. */
export const parseShoppingTextCli = (argv: ReadonlyArray<string>): Result.Result<ShoppingTextCommand, CliError> =>
  readArgs(argv, true, true).pipe(
    Result.flatMap(({ args, positionals }): Result.Result<ShoppingTextCommand, CliError> => {
      if (args.help === true) {
        return Result.succeed({ _tag: "Help" })
      }
      const [weekStart, ...rest] = positionals
      if (weekStart === undefined || rest.length > 0) {
        return Result.fail(
          new CliError({
            message: "Укажите ровно одну дату начала недели в формате ГГГГ-ММ-ДД.",
          })
        )
      }
      if (!isCalendarDate(weekStart)) {
        return Result.fail(
          new CliError({
            message: `Дата ${weekStart} не подходит: нужна дата в формате ГГГГ-ММ-ДД, например 2026-10-17.`,
          })
        )
      }
      return Result.succeed({
        _tag: "Run",
        options: {
          weekStart,
          withOptional: args["with-optional"] === true,
          dataDir: args["data-dir"] ?? DEFAULT_DATA_DIR,
          configDir: args["config-dir"] ?? DEFAULT_CONFIG_DIR,
        },
      })
    })
  )
