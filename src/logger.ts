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

function log(level: LogLevel, source: string | undefined, ...args: unknown[]): void {
  if (LEVEL_NUM[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const tag = source ? `${PREFIX}[${source}]` : PREFIX;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`${ts} ${tag} [${level.toUpperCase()}]`, ...args);
}

/** Create a child logger that tags all entries with a source ID */
export function sourceLogger(sourceId: string) {
  return {
    debug: (...args: unknown[]) => log("debug", sourceId, ...args),
    info: (...args: unknown[]) => log("info", sourceId, ...args),
    warn: (...args: unknown[]) => log("warn", sourceId, ...args),
    error: (...args: unknown[]) => log("error", sourceId, ...args),
  };
}

export const logger = {
  debug: (...args: unknown[]) => log("debug", undefined, ...args),
  info: (...args: unknown[]) => log("info", undefined, ...args),
  warn: (...args: unknown[]) => log("warn", undefined, ...args),
  error: (...args: unknown[]) => log("error", undefined, ...args),
};
