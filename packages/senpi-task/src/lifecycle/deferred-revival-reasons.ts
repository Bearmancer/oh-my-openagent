/** Deferral reasons a resumed session retries for its own child (omo#9498). */
export const SCOPED_RETRY_REASONS: ReadonlySet<string> = new Set([
  "capacity", "lock_contended", "model_unavailable", "session_unavailable",
  "rollback_failed", "foreign_live_owner",
])

/** Retried reasons that end the child as lost once the retries are spent; the others wait for the other side. */
export const LOST_ON_EXHAUSTION: ReadonlySet<string> = new Set([
  "model_unavailable", "session_unavailable", "rollback_failed", "lock_contended",
])
