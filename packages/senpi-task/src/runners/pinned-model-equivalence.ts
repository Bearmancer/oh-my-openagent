const FAST_VARIANT_SUFFIX = "-fast"

interface ModelIdentity {
  readonly provider: string
  readonly id: string
}

/**
 * Whether a child that reports `started` honours the pin `pinned` (#9793).
 *
 * senpi treats a `-fast` catalog entry as the priority service tier of its base model: a session pinned
 * to `X-fast` starts on `X` with the tier remembered (the service-tier builtin's `findBaseModel`), and a
 * session pinned to `X` can come up on `X-fast` when fast mode is remembered. Both are the same upstream
 * model on the same provider, so the post-start pin check accepts the pair. Every other difference -
 * another model, another provider, any other suffix - is still a substitution.
 */
export function startedOnPinnedModel(started: ModelIdentity, pinned: ModelIdentity): boolean {
  if (started.provider !== pinned.provider) return false
  if (started.id === pinned.id) return true
  return started.id === `${pinned.id}${FAST_VARIANT_SUFFIX}` || pinned.id === `${started.id}${FAST_VARIANT_SUFFIX}`
}
