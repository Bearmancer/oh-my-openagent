import { MIN_ACCESS_TOKEN_LENGTH } from "../constants"
import { asArray, asRecord, finiteNumber, nonEmptyString } from "../guards"
import type { PanelAccountState } from "./types"

/**
 * The account a usage request speaks for: its token, its name, and how healthy it is.
 *
 * These three answers are produced together on purpose. Deriving the label from the credential
 * pool while taking the token from "pinned if live" lets the panel print one account's name
 * over another account's quota - the numbers and the name they sit under must come from one
 * decision, and that decision is this function.
 */
export interface PanelUsageCredential {
  readonly access: string
  readonly account?: string
  /** The account the user pinned, when the healthy one doing the work is a different slot. */
  readonly pinnedAccount?: string
  readonly state: PanelAccountState
}

/** A credential-pool slot, as much of it as the panel cares about. */
interface PoolSlot {
  readonly blockedUntil?: number
  readonly cooldownUntil?: number
}

/**
 * `auth` is the parsed `auth.json`, `pool` the parsed `credential-pool-state.json`.
 *
 * A pinned slot the pool has put on cooldown is not the slot doing the work, so the healthy
 * one is reported and marked as a failover. Without the pool sidecar there is no health
 * information, only names, which is a fine degradation: the token still works.
 */
export function resolveUsageCredential(
  auth: unknown,
  pool: unknown,
  provider: string,
  now: number,
): PanelUsageCredential | undefined {
  return resolveOne(auth, pool, provider, [provider], now)
}

/**
 * The first of `providers` that auth.json actually carries.
 *
 * The engine renamed its subscription providers - `claude-sdk-oauth` became
 * `anthropic-subscription`, `openai-codex` became `chatgpt-subscription` - and installs that
 * predate the rename still hold the old spelling, so the current name is read first and the
 * retired one remains a fallback. Reading only the retired name is not a visible error: there is
 * simply no credential, so nothing polls and the block ages in place.
 *
 * Health is looked up under EVERY listed name, because auth.json and the credential pool were
 * renamed on different schedules and a slot filed under the old key still describes this account.
 */
export function resolveUsageCredentialFrom(
  auth: unknown,
  pool: unknown,
  providers: readonly string[],
  now: number,
): PanelUsageCredential | undefined {
  for (const provider of providers) {
    const credential = resolveOne(auth, pool, provider, providers, now)
    if (credential !== undefined) return credential
  }
  return undefined
}

function resolveOne(
  auth: unknown,
  pool: unknown,
  provider: string,
  healthProviders: readonly string[],
  now: number,
): PanelUsageCredential | undefined {
  const node = asRecord(asRecord(auth)?.[provider])
  if (node === undefined) return undefined
  const slots = poolSlots(pool, healthProviders)
  const accounts = asArray(node["accounts"])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)

  /**
   * A rotation is recorded in TWO places and either one means the session has moved on: the pool
   * slot (`blockedUntil` / `cooldownUntil`) and the account object itself, which senpi stamps with
   * `blockedUntil` plus a `blockReason` when it rate-limits one. Reading only the pool let a
   * rate-limited account keep its name over numbers the session was no longer spending.
   */
  const health = (account: Record<string, unknown>): PanelAccountState => {
    const name = nonEmptyString(account["name"])
    const slot = name === undefined ? undefined : slots[name]
    const blocks = [slot?.blockedUntil, slot?.cooldownUntil, finiteNumber(account["blockedUntil"])]
    if (blocks.some((until) => until !== undefined && until > now)) return "cooldown"
    const expires = finiteNumber(account["expires"])
    if (expires !== undefined && expires <= now) return "stale"
    return "ok"
  }

  if (accounts.length > 0) {
    const pinnedName = nonEmptyString(node["pinned"])
    const pinned = accounts.find((account) => nonEmptyString(account["name"]) === pinnedName) ?? accounts[0]
    const healthy = accounts.find((account) => health(account) === "ok" && usableToken(account["access"]))
    // A pinned slot that is merely stale still serves: the endpoint's 401 is what lets the
    // column say "auth stale - run /login", whereas offering nothing says nothing at all.
    const pinnedServes = pinned !== undefined && health(pinned) === "ok" && usableToken(pinned["access"])
    const serving = pinnedServes ? pinned : (healthy ?? (usableToken(pinned?.["access"]) ? pinned : undefined))
    const access = serving === undefined ? undefined : nonEmptyString(serving["access"])
    if (serving !== undefined && access !== undefined && usableToken(access)) {
      const name = nonEmptyString(serving["name"])
      const pinnedLabel = pinned === undefined ? undefined : nonEmptyString(pinned["name"])
      return {
        access,
        state: health(serving),
        ...(name === undefined ? {} : { account: name }),
        ...(pinnedLabel === undefined || pinnedLabel === name ? {} : { pinnedAccount: pinnedLabel }),
      }
    }
  }

  // A single-account credential carries the token at the top level and has no name to print.
  const flat = nonEmptyString(node["access"])
  if (flat !== undefined && usableToken(flat)) {
    const expires = node["expires"]
    return { access: flat, state: typeof expires === "number" && expires <= now ? "stale" : "ok" }
  }
  return undefined
}

function poolSlots(pool: unknown, providerIds: readonly string[]): Readonly<Record<string, PoolSlot>> {
  const providers = asRecord(asRecord(pool)?.["providers"])
  const parsed: Record<string, PoolSlot> = {}
  for (const provider of providerIds) {
    const lanes = asRecord(asRecord(providers?.[provider])?.["lanes"])
    const slots = asRecord(asRecord(lanes?.["stored"])?.["slots"])
    if (slots === undefined) continue
    collectSlots(slots, parsed)
  }
  return parsed
}

function collectSlots(slots: Record<PropertyKey, unknown>, parsed: Record<string, PoolSlot>): void {
  for (const [name, value] of Object.entries(slots)) {
    const slot = asRecord(value)
    if (slot === undefined) continue
    const blockedUntil = slot["blockedUntil"]
    const cooldownUntil = slot["cooldownUntil"]
    parsed[name] = {
      ...(typeof blockedUntil === "number" ? { blockedUntil } : {}),
      ...(typeof cooldownUntil === "number" ? { cooldownUntil } : {}),
    }
  }
}

function usableToken(value: unknown): boolean {
  return typeof value === "string" && value.length >= MIN_ACCESS_TOKEN_LENGTH
}




