export interface ModelIdentity {
  readonly provider: string
  readonly id: string
}

export type CatalogModelIdentity = ModelIdentity & {
  readonly serviceTier?: string
  readonly upstreamModelId?: string
}

export type EffectiveModel = ModelIdentity & { readonly serviceTier?: string }

/** A catalog priority alias, not a different SKU that happens to end in `-fast`. */
export function isPriorityAliasOf(entry: unknown, base: ModelIdentity): boolean {
  return typeof entry === "object" && entry !== null
    && "provider" in entry && entry.provider === base.provider
    && "id" in entry && entry.id === `${base.id}-fast`
    && "serviceTier" in entry && entry.serviceTier === "priority"
    && "upstreamModelId" in entry && entry.upstreamModelId === base.id
}

/** The alias entry is the pairing proof in whichever direction the engine started. */
export function startedOnPinnedModel(started: ModelIdentity, pinned: ModelIdentity, pinnedEntry: unknown): boolean {
  if (started.provider !== pinned.provider) return false
  if (started.id === pinned.id) return true
  return isPriorityAliasOf(started, pinned) || isPriorityAliasOf(pinnedEntry, started)
}

/** The effective tier comes from the session, never the catalog's requested tier. */
export function reportedEffectiveModel(model: ModelIdentity | undefined, serviceTier: string | undefined): EffectiveModel | undefined {
  return model === undefined ? undefined : {
    provider: model.provider, id: model.id,
    ...(serviceTier === undefined ? {} : { serviceTier }),
  }
}
