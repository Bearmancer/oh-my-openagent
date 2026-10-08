import type { OmoConfig } from "@oh-my-opencode/omo-config-core"

import { inheritParentFastMode, type ResolveParentServiceTier } from "./fast-mode-inheritance"
import {
  resolveAgent,
  resolveCategory,
  resolveExplicitTaskPin,
  splitModelDecorators,
  type AgentDefinition,
  type ChildPlanner,
  type ExplicitPinRuntime,
  type PlanResolution,
  type ResolvedAgentResult,
  type SenpiModelPort,
  type SenpiModelRegistryPort,
  type SettingsDefaultRoute,
} from "@oh-my-opencode/senpi-task"

type ResolvedPlan = Extract<PlanResolution, { readonly kind: "resolved" }>["plan"]
type ResolvedModelMetadata = NonNullable<ResolvedPlan["resolved_model"]>

// The live senpi model registry surface the planner needs. ExtensionContext.modelRegistry satisfies
// it structurally; a fake with getAvailable/find satisfies it in tests. `modelRuntime` rides along
// on the concrete registry: explicit pins resolve through senpi's own `resolveCliModel`, which
// needs the runtime's catalog, so a registry without one can only offer exact-id `find` matching.
export type TaskModelRegistry = SenpiModelRegistryPort<SenpiModelPort> & {
  readonly modelRuntime?: ExplicitPinRuntime
}

export type ResolveModelRegistry = () => TaskModelRegistry | undefined

// The settings-default route a pin-less child would start on, named in model_unavailable errors so
// the caller sees exactly what the refusal protected it from.
export type ResolveDefaultRoute = () => SettingsDefaultRoute | undefined

const NO_REGISTRY_MESSAGE = "No senpi model registry is available yet to resolve a task model."

// The category-and-agent resolving ChildPlanner the manager consumes. Resolution order:
// 1. a subagent_type naming a known agent wins: an explicit `model` pin is parsed ONCE with
//    senpi's own resolver and must resolve against the live registry, or the spawn fails typed
//    (#9722); otherwise the agent's model chain resolves against the live registry and a missing
//    registry fails closed as model_unavailable. A subagent_type naming no enabled agent is a
//    typed unknown_target error - never a category lookup of the same string (#8348).
// 2. an explicit `model` alone is the same parsed pin: canonical provider/model_id plus thinking
//    level, resolved or failed.
// 3. a category resolves against omo.json + the registry.
// Whatever path resolved, the plan then inherits the parent's effective execution tier
// (fast-mode-inheritance.ts) so a fast parent never delegates to a standard-tier child.
export function createTaskChildPlanner(
  omoConfig: OmoConfig,
  agents: Readonly<Record<string, AgentDefinition>>,
  resolveRegistry: ResolveModelRegistry,
  resolveParentServiceTier: ResolveParentServiceTier = () => undefined,
  resolveDefaultRoute?: ResolveDefaultRoute,
): ChildPlanner {
  const availableAgents = listAvailableAgents(agents)
  const planChild = (spec: Parameters<ChildPlanner>[0]): PlanResolution => {
    if (spec.subagent_type !== undefined) {
      const agentResolution = resolveAgentTarget(spec.subagent_type, spec.model, agents, resolveRegistry, omoConfig, resolveDefaultRoute)
      return agentResolution ?? unresolvableAgentTarget(spec.subagent_type, availableAgents, resolveRegistry, omoConfig)
    }

    if (spec.model !== undefined && spec.model.length > 0) {
      const pin = resolveExplicitPin(spec.model, resolveRegistry, resolveDefaultRoute)
      if (pin.kind !== "resolved") return { kind: "error", error: pin.error }
      return {
        kind: "resolved",
        plan: {
          model: pin.canonical,
          resolved_model: pin.metadata,
          ...(pin.thinkingLevel === undefined ? {} : { variant: pin.thinkingLevel }),
        },
      }
    }

    const categoryName = spec.category
    if (categoryName === undefined) {
      return { kind: "error", error: { code: "invalid_target", message: "A task requires a category, subagent_type, or model." } }
    }

    const registry = resolveRegistry()
    if (registry === undefined) {
      return {
        kind: "error",
        error: { code: "model_unavailable", message: NO_REGISTRY_MESSAGE },
      }
    }

    const resolution = resolveCategory(categoryName, omoConfig, registry)
    return toPlanResolution(categoryName, resolution, availableAgents)
  }
  return (spec): PlanResolution => {
    const resolution = planChild(spec)
    if (resolution.kind !== "resolved") return resolution
    return {
      kind: "resolved",
      plan: inheritParentFastMode(resolution.plan, resolveRegistry(), resolveParentServiceTier()),
    }
  }
}

// Agent-first target handling. `undefined` means "this name is no enabled agent" - unknown or
// disabled alike, with or without an explicit model, so a disabled agent can never be revived by a
// call-site model. The caller turns that into a typed error; it is never a category lookup.
function resolveAgentTarget(
  agentName: string,
  explicitModel: string | undefined,
  agents: Readonly<Record<string, AgentDefinition>>,
  resolveRegistry: ResolveModelRegistry,
  omoConfig: OmoConfig,
  resolveDefaultRoute?: ResolveDefaultRoute,
): PlanResolution | undefined {
  if (explicitModel !== undefined && explicitModel.length > 0) {
    const resolution = resolveAgent(agentName, agents, undefined, { modelOverride: explicitModel })
    if (resolution.kind !== "resolved") return undefined
    const pin = resolveExplicitPin(explicitModel, resolveRegistry, resolveDefaultRoute)
    if (pin.kind !== "resolved") return { kind: "error", error: pin.error }
    return { kind: "resolved", plan: toAgentPlan(resolution, pin.metadata, pin.canonical) }
  }

  const registry = resolveRegistry()
  const resolution = resolveAgent(agentName, agents, registry, { omoConfig })
  if (resolution.kind === "resolved") {
    return { kind: "resolved", plan: toAgentPlan(resolution, undefined) }
  }
  if (resolution.kind === "model_unavailable") {
    if (registry === undefined) {
      return { kind: "error", error: { code: "model_unavailable", message: NO_REGISTRY_MESSAGE } }
    }
    return {
      kind: "error",
      error: {
        code: "model_unavailable",
        message: `No available model for agent "${agentName}" (attempted ${resolution.attemptedModel ?? "none"}).`,
        availableAgents: resolution.availableAgents,
      },
    }
  }
  return undefined
}

// A subagent_type names an AGENT. When it names none, the caller is told so by name and pointed at
// the valid targets - and, when the string happens to be a category key, at the `category` field it
// meant. Falling through to a category lookup instead (the pre-#8348 behavior) silently handed the
// caller another family's model with no error and no warning.
function unresolvableAgentTarget(
  agentName: string,
  availableAgents: readonly string[],
  resolveRegistry: ResolveModelRegistry,
  omoConfig: OmoConfig,
): PlanResolution {
  const registry = resolveRegistry()
  const category = registry === undefined ? undefined : resolveCategory(agentName, omoConfig, registry)
  const categoryHint =
    category !== undefined && category.kind !== "not_found"
      ? ` "${agentName}" is a category, not an agent — use category="${agentName}" instead.`
      : ""
  return {
    kind: "error",
    error: {
      code: "unknown_target",
      message: `Subagent type "${agentName}" is not an available agent.${categoryHint}`,
      availableAgents,
      ...(category !== undefined ? { availableCategories: category.availableCategories } : {}),
    },
  }
}

function toAgentPlan(resolution: ResolvedAgentResult, explicitModel: ResolvedModelMetadata | undefined, canonicalModel?: string): ResolvedPlan {
  const resolvedModel = resolution.resolved_model ?? explicitModel
  // Identical precedence to the category path below: reasoning outranks reasoningEffort outranks
  // variant, and whichever is chosen becomes the child's thinking level through asSenpiThinkingLevel.
  const appliedVariant = resolvedModel?.reasoning ?? resolvedModel?.reasoning_effort ?? resolvedModel?.variant
  return {
    model: canonicalModel ?? resolution.model,
    ...(resolution.requested_model !== undefined
      ? { requested_model: resolution.requested_model }
      : {}),
    ...(resolution.fallback_models !== undefined
      ? { fallback_models: resolution.fallback_models }
      : {}),
    ...(resolvedModel !== undefined ? { resolved_model: resolvedModel } : {}),
    ...(appliedVariant !== undefined ? { variant: appliedVariant } : {}),
    agentType: resolution.agentType,
    ...(resolution.instructions !== undefined ? { instructions: resolution.instructions } : {}),
    ...(resolution.toolAllowlist !== undefined ? { toolAllowlist: resolution.toolAllowlist } : {}),
    // The denylist must travel too: it becomes the record's tool_deny -> ChildSpec.toolDenylist ->
    // senpi excludeTools, and a deny-only agent is otherwise invisible to every policy check.
    ...(resolution.toolDenylist !== undefined ? { toolDenylist: resolution.toolDenylist } : {}),
    ...(resolution.agentExecutionMode !== undefined ? { agentExecutionMode: resolution.agentExecutionMode } : {}),
    ...(resolution.allowedSubagents !== undefined ? { allowedSubagents: resolution.allowedSubagents } : {}),
    ...(resolution.maxDepth !== undefined ? { maxDepth: resolution.maxDepth } : {}),
  }
}

function listAvailableAgents(agents: Readonly<Record<string, AgentDefinition>>): readonly string[] {
  return Object.entries(agents)
    .filter(([, definition]) => definition.disable !== true)
    .map(([name]) => name)
    .sort()
}

function toPlanResolution(
  categoryName: string,
  resolution: ReturnType<typeof resolveCategory<SenpiModelPort>>,
  availableAgents: readonly string[],
): PlanResolution {
  if (resolution.kind === "resolved") {
    const appliedVariant = resolution.spec.reasoning ?? resolution.spec.reasoningEffort ?? resolution.spec.variant
    return {
      kind: "resolved",
      plan: {
        model: `${resolution.spec.provider}/${resolution.spec.modelId}`,
        ...(resolution.spec.requested_model !== undefined
          ? { requested_model: resolution.spec.requested_model }
          : {}),
        ...(resolution.spec.fallback_models !== undefined
          ? { fallback_models: resolution.spec.fallback_models }
          : {}),
        resolved_model: {
          source: "category",
          provider: resolution.spec.provider,
          model_id: resolution.spec.modelId,
          display: resolution.spec.displayName ?? `${resolution.spec.provider}/${resolution.spec.modelId}`,
          ...(resolution.spec.variant !== undefined ? { variant: resolution.spec.variant } : {}),
          ...(resolution.spec.reasoningEffort !== undefined ? { reasoning_effort: resolution.spec.reasoningEffort } : {}),
          ...(resolution.spec.reasoning !== undefined ? { reasoning: resolution.spec.reasoning } : {}),
        },
        ...(appliedVariant !== undefined ? { variant: appliedVariant } : {}),
        category: resolution.category,
        ...(resolution.spec.prompt_append !== undefined && { promptAppend: resolution.spec.prompt_append }),
      },
    }
  }
  if (resolution.kind === "disabled") {
    return {
      kind: "error",
      error: { code: "category_disabled", message: resolution.reason, availableCategories: resolution.availableCategories },
    }
  }
  if (resolution.kind === "not_found") {
    return {
      kind: "error",
      error: {
        code: "unknown_target",
        message: `Category "${categoryName}" not found.`,
        availableAgents,
        availableCategories: resolution.availableCategories,
      },
    }
  }
  return {
    kind: "error",
    error: {
      code: "model_unavailable",
      message: `No available model for category "${categoryName}" (attempted ${resolution.attemptedModel ?? "none"}).`,
      availableCategories: resolution.availableCategories,
      // Dead-chain detail rides the error so the warning layer can surface it without re-resolving.
      category: categoryName,
      ...(resolution.attempted_chain !== undefined && { attempted_chain: resolution.attempted_chain }),
      ...(resolution.missing_providers !== undefined && { missing_providers: resolution.missing_providers }),
      ...(resolution.unlisted_provider_model !== undefined && { unlisted_provider_model: resolution.unlisted_provider_model }),
    },
  }
}

type ExplicitPinResolution =
  | { readonly kind: "resolved"; readonly canonical: string; readonly metadata: ResolvedModelMetadata; readonly thinkingLevel?: string }
  | { readonly kind: "error"; readonly error: { readonly code: "invalid_target" | "model_unavailable"; readonly message: string } }

/**
 * Parse an explicit task model pin ONCE and resolve it against the live registry, or fail closed
 * (#9722): the raw `provider/model:level` string is never trusted as a model id again. senpi's own
 * resolver owns the split whenever the registry carries its runtime; a structurally minimal
 * registry (unit fakes) falls back to exact-id `find` on the shared decorator split. Either way a
 * miss is a typed model_unavailable naming the pin and the settings default the child would
 * otherwise have ridden, and a malformed pin is a typed invalid_target.
 */
function resolveExplicitPin(
  pin: string,
  resolveRegistry: ResolveModelRegistry,
  resolveDefaultRoute: ResolveDefaultRoute | undefined,
): ExplicitPinResolution {
  const registry = resolveRegistry()
  if (registry === undefined) {
    return { kind: "error", error: { code: "model_unavailable", message: withDefaultRoute(NO_REGISTRY_MESSAGE, resolveDefaultRoute) } }
  }
  const runtime = registry.modelRuntime
  if (runtime !== undefined) {
    const resolved = resolveExplicitTaskPin(pin, runtime)
    if (resolved.kind !== "resolved") {
      return {
        kind: "error",
        error: {
          code: resolved.kind,
          message: resolved.kind === "model_unavailable" ? withDefaultRoute(resolved.message, resolveDefaultRoute) : resolved.message,
        },
      }
    }
    return explicitPinResolved(pin, resolved.provider, resolved.modelId, resolved.thinkingLevel)
  }
  return resolvePinByExactId(pin, registry, resolveDefaultRoute)
}

function resolvePinByExactId(
  pin: string,
  registry: TaskModelRegistry,
  resolveDefaultRoute: ResolveDefaultRoute | undefined,
): ExplicitPinResolution {
  const { base, thinkingLevel } = splitModelDecorators(pin.trim())
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) {
    return {
      kind: "error",
      error: { code: "invalid_target", message: `The task model pin "${pin}" is malformed: use provider/model with an optional :thinking-level suffix.` },
    }
  }
  const provider = base.slice(0, slash)
  const modelId = base.slice(slash + 1)
  const found = registry.find(provider, modelId)
  if (found === undefined) {
    return {
      kind: "error",
      error: {
        code: "model_unavailable",
        message: withDefaultRoute(`The task model pin "${pin}" did not resolve to a model in the live registry.`, resolveDefaultRoute),
      },
    }
  }
  return explicitPinResolved(pin, provider, modelId, thinkingLevel)
}

function explicitPinResolved(
  pin: string,
  provider: string,
  modelId: string,
  thinkingLevel: string | undefined,
): ExplicitPinResolution {
  return {
    kind: "resolved",
    canonical: `${provider}/${modelId}`,
    metadata: {
      source: "explicit",
      provider,
      model_id: modelId,
      display: pin,
      ...(thinkingLevel === undefined ? {} : { reasoning: thinkingLevel }),
    },
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  }
}

function withDefaultRoute(message: string, resolveDefaultRoute: ResolveDefaultRoute | undefined): string {
  const route = resolveDefaultRoute?.()
  return route === undefined
    ? message
    : `${message} The child would otherwise start on the settings default route ${route.provider}/${route.modelId}.`
}
