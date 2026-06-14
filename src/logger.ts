/** Simple structured logger for mcp-nexus */

const PREFIX = "[nexus]";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_NUM: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: number = LEVEL_NUM.info;

export function setLogLevel(level: LogLevel): void {
  currentLevel = LEVEL_NUM[level];
}

function log(level: LogLevel, ...args: unknown[]): void {
  if (LEVEL_NUM[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`${ts} ${PREFIX} [${level.toUpperCase()}]`, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", ...args),
  info: (...args: unknown[]) => log("info", ...args),
  warn: (...args: unknown[]) => log("warn", ...args),
  error: (...args: unknown[]) => log("error", ...args),
};
