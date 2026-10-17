import { Effect, Schema } from "effect"
import { Argument, Command } from "effect/cli"
import { configDirFlag, DEFAULT_CONFIG_DIR, DEFAULT_DATA_DIR, dataDirFlag, switchFlag } from "../cli/flags.ts"
import { isCalendarDate } from "../domain/calendar.ts"

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

const dataDirDescription = (text: string) => `${text} (по умолчанию ${DEFAULT_DATA_DIR}).`
const configDirDescription = `Каталог с настройками (по умолчанию ${DEFAULT_CONFIG_DIR}).`

/** A real calendar day in the form `ГГГГ-ММ-ДД`. */
const WeekStart = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (text: string) =>
        isCalendarDate(text) || `Дата ${text} не подходит: нужна дата в формате ГГГГ-ММ-ДД, например 2026-10-17.`
    )
  )
)

const planDirectoryFlags = {
  dataDir: dataDirFlag(dataDirDescription("Каталог с данными: parsed, enriched, plans")),
  configDir: configDirFlag(configDirDescription),
}

const directoryFlags = {
  dataDir: dataDirFlag(dataDirDescription("Каталог с данными")),
  configDir: configDirFlag(configDirDescription),
}

/** `npm run items:report`. The handler gets the parsed options. */
export const makeItemsReportCommand = <E, R>(handler: (options: ItemsReportOptions) => Effect.Effect<void, E, R>) =>
  Command.make("items:report", directoryFlags, handler).pipe(
    Command.withDescription(
      [
        "Читает каталог (<data-dir>/parsed и <data-dir>/enriched) и пишет <data-dir>/items-report.json:",
        "каждый нормализованный продукт с числом рецептов и написаниями из рецептов.",
        "По этому файлу заполняют config/item-aliases.json.",
      ].join("\n  ")
    )
  )

/** `npm run servings:report`: the same options as `items:report`. */
export const makeServingsReportCommand = <E, R>(handler: (options: ItemsReportOptions) => Effect.Effect<void, E, R>) =>
  Command.make("servings:report", directoryFlags, handler).pipe(
    Command.withDescription(
      [
        "Читает каталог (<data-dir>/parsed и <data-dir>/enriched) и config/servings-overrides.json,",
        "ищет рецепты с подозрительным числом порций и пишет <data-dir>/servings-report.json.",
        "Рецепт попадает в отчёт, если порции оценены моделью, их больше 12, max больше 3 × min",
        "или масса порции вне 150–700 г.",
      ].join("\n  ")
    )
  )

/** `npm run plan:check <file>`. The handler gets the parsed options. */
export const makePlanCheckCommand = <E, R>(handler: (options: PlanCheckOptions) => Effect.Effect<void, E, R>) =>
  Command.make(
    "plan:check",
    {
      file: Argument.String("файл").pipe(Argument.withDescription("План недели: JSON, форма WeekPlan.")),
      ...planDirectoryFlags,
    },
    handler
  ).pipe(
    Command.withDescription(
      [
        "Проверяет план недели (JSON, форма WeekPlan) по правилам семьи",
        "и печатает оценку плана и список покупок в Markdown.",
        "Код выхода 1, если в плане есть ошибки.",
      ].join("\n  ")
    )
  )

/** `npm run shopping:text <date>`. The handler gets the parsed options. */
export const makeShoppingTextCommand = <E, R>(handler: (options: ShoppingTextOptions) => Effect.Effect<void, E, R>) =>
  Command.make(
    "shopping:text",
    {
      weekStart: Argument.String("дата-начала-недели").pipe(
        Argument.withSchema(WeekStart),
        Argument.withDescription("Первый день недели плана, ГГГГ-ММ-ДД.")
      ),
      withOptional: switchFlag("with-optional", "Добавить строки «по желанию» после покупок."),
      ...directoryFlags,
    },
    handler
  ).pipe(
    Command.withDescription(
      [
        "Читает план недели <data-dir>/plans/<дата начала недели>.json и печатает список покупок",
        "простым текстом: одна строка на продукт, «продукт — количество». Без заголовков.",
        "Текст идёт в stdout, предупреждения в stderr. Для буфера обмена на macOS:",
        "  npm run -s shopping:text -- 2026-10-17 | pbcopy",
        "Текст можно вставить в чек-лист заметки Google Keep.",
      ].join("\n  ")
    )
  )
