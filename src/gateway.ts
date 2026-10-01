/**
 * The gateway: who is calling, what they may call, and a record of what they did.
 *
 * Before this the nexus had one shared token and no idea which client a call came
 * from, so it could neither say who did something nor stop one client doing what
 * another may. Each client now has its own token (MCP_NEXUS_TOKEN_<NAME>), and the
 * name it authenticates as travels with every call into policy and the call log.
 *
 * Policy is enforced in call_tool, because that is the only door to an upstream —
 * `sources[].filter` shapes the index for everyone and was never a control. The same
 * policy also hides what a client may not call from browse and search, so an agent
 * is not shown tools it can only be refused.
 *
 * Nothing here is on by default. A deployment with the shared token and no
 * `auth.clients` behaves exactly as it did, with every call now logged under
 * `default`.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_CLIENT } from "./config.js";
import { matchGlob } from "./glob-utils.js";
import { sourceLogger } from "./logger.js";
import type { AuthConfig, ClientPolicy } from "./types.js";

// ─── Authentication ──────────────────────────────────────────────────────────

/** The client name auth-disabled deployments attribute every call to. */
export const ANONYMOUS_CLIENT = "anonymous";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The client an Authorization header authenticates as, or null when it matches no
 * token. Every token is compared, whichever matches, so the time taken does not say
 * how far down the list a near miss got.
 */
export function authenticate(header: string | undefined, auth: AuthConfig): string | null {
  if (!auth.enabled) return ANONYMOUS_CLIENT;
  const presented = header ?? "";

  let client: string | null = null;
  const candidates: Array<[string, string]> = [
    ...(auth.token ? ([[DEFAULT_CLIENT, auth.token]] as Array<[string, string]>) : []),
    ...Object.entries(auth.clientTokens),
  ];
  for (const [name, token] of candidates) {
    if (safeEqual(presented, `Bearer ${token}`) && client === null) client = name;
  }
  return client;
}

// ─── Policy ──────────────────────────────────────────────────────────────────

const OPEN: ClientPolicy = { confirmDestructive: false };

/** One client's view of the tool set: what it can see, and what needs confirming. */
export class ClientAccess {
  readonly name: string;
  private readonly policy: ClientPolicy;

  constructor(name: string, policy: ClientPolicy | undefined) {
    this.name = name;
    this.policy = policy ?? OPEN;
  }

  static for(name: string, auth: AuthConfig): ClientAccess {
    return new ClientAccess(name, auth.clients[name]);
  }

  /** Whether the client may see and call a tool, by its namespaced name. */
  permits(toolName: string): boolean {
    const { allow, deny } = this.policy;
    if (deny?.some((pattern) => matchGlob(toolName, pattern))) return false;
    if (allow && !allow.some((pattern) => matchGlob(toolName, pattern))) return false;
    return true;
  }

  /** Whether this client can ever be asked to confirm — decides if `confirm` is advertised. */
  get confirms(): boolean {
    return this.policy.confirmDestructive || (this.policy.confirm?.length ?? 0) > 0;
  }

  /**
   * Why a call needs confirming first, or undefined when it does not.
   *
   * The annotation is only honoured when it is explicitly true. MCP defaults
   * `destructiveHint` to true for any tool not marked read-only, so reading an absent
   * annotation as destructive would gate every unannotated tool — all of Todoist and
   * eBay — and an agent asked to confirm everything learns to confirm without looking.
   */
  confirmationReason(toolName: string, tool: Tool): string | undefined {
    if (this.policy.confirm?.some((pattern) => matchGlob(toolName, pattern))) {
      return `this client's policy lists ${toolName} as needing confirmation`;
    }
    if (this.policy.confirmDestructive && tool.annotations?.destructiveHint === true) {
      return `the service marks ${toolName} as destructive`;
    }
    return undefined;
  }
}

// ─── Confirmation ────────────────────────────────────────────────────────────

/** How long a confirmation stays valid: long enough to ask a person, short enough to go stale. */
export const CONFIRMATION_TTL_MS = 5 * 60_000;

interface PendingConfirmation {
  digest: string;
  expires: number;
}

function callDigest(client: string, toolName: string, parameters: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([client, toolName, canonical(parameters)])).digest("hex");
}

/** Key-sorted copy, so argument order does not change what a call is. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Tokens that let one specific call through the confirmation gate.
 *
 * A token is bound to the client, the tool and the exact arguments, and is spent on
 * use. So a confirmation for "delete event X" cannot be replayed to delete event Y,
 * or by another client, or twice. What it cannot do is prove a person said yes — the
 * agent holds the token — so the refusal tells it to ask first, and the call log
 * records each refusal and each confirmed call for whoever reviews them.
 */
export class ConfirmationStore {
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(client: string, toolName: string, parameters: Record<string, unknown>): string {
    this.prune();
    const token = randomBytes(9).toString("base64url");
    this.pending.set(token, { digest: callDigest(client, toolName, parameters), expires: this.now() + CONFIRMATION_TTL_MS });
    return token;
  }

  /** Spend a token. True only when it was issued for exactly this call and has not expired. */
  redeem(token: string, client: string, toolName: string, parameters: Record<string, unknown>): boolean {
    this.prune();
    const entry = this.pending.get(token);
    if (!entry || entry.digest !== callDigest(client, toolName, parameters)) return false;
    this.pending.delete(token);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.pending) {
      if (entry.expires <= now) this.pending.delete(token);
    }
  }
}

// ─── Call log ────────────────────────────────────────────────────────────────

export type CallOutcome =
  | "ok"
  | "tool_error"
  | "transport_error"
  | "invalid_arguments"
  | "not_found"
  | "denied"
  | "confirmation_required"
  | "artefact_error";

export interface CallRecord {
  client: string;
  tool: string;
  outcome: CallOutcome;
  ms: number;
  /** Argument names only. Values are never logged: they carry message bodies, addresses and IDs. */
  args: string[];
  select?: number;
  artefacts?: string;
  confirmed?: true;
}

const callLog = sourceLogger("calls");

/**
 * One JSON line per call_tool, tagged `[nexus][calls]` so the log can be filtered to
 * calls alone: `docker logs mcp-nexus | grep '\[calls\]'`.
 */
export function logCall(record: CallRecord): void {
  callLog.info(JSON.stringify(record));
}
