/**
 * T123: общие правила запуска/переиспользования одного экземпляра клиента.
 * Автозапуск (`openAtLogin`) стартует клиент с `--hidden`: трей без окна.
 * Повторный `--hidden`-запуск (например, автозапуск поверх уже открытого
 * клиента) не должен показывать окно — single-instance сам его гасит.
 */

export const HIDDEN_ARG = '--hidden';

export function isHiddenLaunch(commandLine: readonly string[]): boolean {
  return commandLine.includes(HIDDEN_ARG);
}

/** Второй экземпляр: показывать окно только для явных пользовательских запусков. */
export function shouldRevealOnSecondInstance(commandLine: readonly string[]): boolean {
  return !isHiddenLaunch(commandLine);
}

/** Аргументы login item: всегда скрытый старт в трее. */
export function loginItemArgs(): string[] {
  return [HIDDEN_ARG];
}
