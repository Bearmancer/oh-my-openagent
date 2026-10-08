import { afterEach, describe, expect, test } from "bun:test"

import { writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentSession } from "@code-yeongyu/senpi"

import { createTaskChildPlanner } from "../../../omo-senpi/src/components/task/planner"
import { createParentRegistrySessionContext } from "../manager/parent-registry-context"
import { readSettingsDefaultRoute } from "../senpi/explicit-pin"
import type { ManagedStartSpec } from "../manager/types"
import { InProcessRunner } from "./in-process"
import { createBuiltinChildMachine, type BuiltinChildMachine } from "./in-process/__fixtures__/builtin-child"

// #9722. An explicit task model pin - suffixed with a thinking level or not - is honoured or the
// spawn fails loudly, never a silent ride on the child's settings default. The child is the REAL
// builtin in-process fixture against a fake provider whose settings default is a different model,
// so a substituted route is visible in the child's own session log and thinking level.
//
// omo-senpi is imported by SOURCE path (senpi-task holds no dependency on the adapter): the
// planner owns the explicit-pin parse, and this test drives the same composition the engine wires.

type ManagedSpec = Parameters<ReturnType<typeof createParentRegistrySessionContext>>[0]
type PlanResolution = ReturnType<ReturnType<typeof createTaskChildPlanner>>
type ResolvedPlan = Extract<PlanResolution, { readonly kind: "resolved" }>["plan"]

const machines: BuiltinChildMachine[] = []
const sessions: AgentSession[] = []

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
  for (const machine of machines.splice(0)) machine.cleanup()
})

async function world(defaultModelId: string): Promise<BuiltinChildMachine> {
  const machine = await createBuiltinChildMachine()
  machines.push(machine)
  writeFileSync(
    join(machine.agentDir, "settings.json"),
    `${JSON.stringify({ defaultProvider: "runtime-fallback-test", defaultModel: defaultModelId }, null, 2)}\n`,
  )
  return machine
}

function planFor(machine: BuiltinChildMachine, pin: string): PlanResolution {
  return createTaskChildPlanner(
    {},
    {},
    () => machine.modelRegistry,
    () => undefined,
    () => readSettingsDefaultRoute({ cwd: machine.cwd, agentDir: machine.agentDir }),
  )({
    prompt: "reply with done",
    parent_session_id: "parent-9722",
    depth: 1,
    model: pin,
  })
}

function managedSpec(machine: BuiltinChildMachine, taskId: string, plan: ResolvedPlan): ManagedSpec {
  return {
    taskId,
    cwd: machine.cwd,
    stateDir: join(machine.agentDir, "state"),
    prompt: "reply with done",
    depth: 1,
    parentSessionId: "parent-9722",
    rootSessionId: "parent-9722",
    model: plan.model,
    ...(plan.resolved_model === undefined ? {} : { resolvedModel: plan.resolved_model }),
    ...(plan.variant === undefined ? {} : { variant: plan.variant }),
  }
}

async function startPlannedChild(machine: BuiltinChildMachine, plan: ResolvedPlan, taskId: string): Promise<AgentSession> {
  const provide = createParentRegistrySessionContext(() => machine.modelRegistry)
  const context = provide(managedSpec(machine, taskId, plan))
  const runner = new InProcessRunner({
    createSession: async (options) => {
      const session = (await (await import("@code-yeongyu/senpi")).createAgentSession(options)).session
      sessions.push(session)
      await session.bindExtensions({ mode: "print" })
      return session
    },
  })
  const handle = await runner.start({
    ...machine.spec(taskId, "succeeds"),
    model: context.model,
    modelRuntime: context.modelRuntime,
    selectedModel: plan.model,
    ...(context.thinkingLevel === undefined ? {} : { thinkingLevel: context.thinkingLevel }),
  })
  await handle.waitForIdle()
  await handle.dispose()
  const session = sessions.at(-1)
  if (session === undefined) throw new Error("the child session was not created")
  return session
}

function firstSessionEntry(machine: BuiltinChildMachine, taskId: string, entryType: string): Record<string, unknown> {
  const root = join(machine.agentDir, "..", "children", taskId)
  const { readdirSync, readFileSync, existsSync } = require("node:fs") as typeof import("node:fs")
  if (!existsSync(root)) throw new Error(`no child session dir at ${root}`)
  const jsonl: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.name.endsWith(".jsonl")) jsonl.push(path)
    }
  }
  walk(root, 0)
  for (const path of jsonl.sort()) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof entry === "object" && entry !== null && "type" in entry && entry.type === entryType) {
        return entry as Record<string, unknown>
      }
    }
  }
  throw new Error(`no ${entryType} entry under ${root}`)
}

describe("explicit task model pins are honoured or fail loudly (#9722)", () => {
  test("1(a)+(d) #given a settings default of child-fails #when spawned with child-succeeds:medium #then the child's first model_change is the pin at medium and the plan matches it", async () => {
    // given: the isolated agent dir defaults to model B; the pin asks for model A at medium
    const machine = await world("child-fails")
    const resolution = planFor(machine, "runtime-fallback-test/child-succeeds:medium")
    if (resolution.kind !== "resolved") throw new Error(`pin did not plan: ${resolution.kind}`)

    // when
    const session = await startPlannedChild(machine, resolution.plan, "st_9722_a")

    // then: the child started on the pinned model at the pinned level, never the settings default
    expect(session.model?.id).toBe("child-succeeds")
    expect(session.thinkingLevel).toBe("medium")
    const change = firstSessionEntry(machine, "st_9722_a", "model_change")
    expect(change.provider).toBe("runtime-fallback-test")
    expect(change.modelId).toBe("child-succeeds")
    expect(change.originalModelId).toBeUndefined()
    expect(firstSessionEntry(machine, "st_9722_a", "thinking_level_change").thinkingLevel).toBe("medium")
    // (d): the plan's canonical model equals the child's first model_change
    expect(resolution.plan.model).toBe(`${String(change.provider)}/${String(change.modelId)}`)
    expect(resolution.plan.resolved_model?.model_id).toBe("child-succeeds")
    expect(resolution.plan.variant).toBe("medium")
  }, 30_000)

  test("1(b) #given an unhonourable pin #when planned or started #then it fails typed naming the pin and the default route", async () => {
    // given
    const machine = await world("child-fails")

    // when / then: the planner fails closed with the pin and the would-be default route
    const resolution = planFor(machine, "runtime-fallback-test/child-missing")
    expect(resolution.kind).toBe("error")
    if (resolution.kind === "error") {
      expect(resolution.error.code).toBe("model_unavailable")
      expect(resolution.error.message).toContain("runtime-fallback-test/child-missing")
      expect(resolution.error.message).toContain("runtime-fallback-test/child-fails")
    }

    // and: a spec that still carries the raw pin dies in the registry context, not in the child
    const provide = createParentRegistrySessionContext(() => machine.modelRegistry)
    expect(() =>
      provide(managedSpec(machine, "st_9722_b", {
        model: "runtime-fallback-test/child-missing",
      })),
    ).toThrow(/child-missing/)
    expect(sessions).toEqual([])
  }, 30_000)

  test("1(c) #given a pin to a model registered only after planning #then the spawn never rides the settings default", async () => {
    // given: model C is absent while the child is planned
    const machine = await world("child-fails")
    const early = planFor(machine, "runtime-fallback-test/child-late")
    expect(early.kind).toBe("error")

    // when: C appears after planning, on a provider the pin did not name
    Reflect.apply(machine.modelRegistry.registerProvider, machine.modelRegistry, ["runtime-fallback-test-late", {
      api: "openai-completions",
      baseUrl: "file://runtime-fallback-test-late",
      apiKey: "test-key",
      models: [{
        id: "child-late",
        name: "child-late",
        reasoning: false,
        input: ["text"] as Array<"text">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      }],
      streamSimple() {
        throw new Error("unused")
      },
    }])

    // then: the registry-context assertion still fails typed for the pin - it resolves the named
    // provider's model or nothing; it can never land on the settings default child-fails
    const provide = createParentRegistrySessionContext(() => machine.modelRegistry)
    expect(() =>
      provide(managedSpec(machine, "st_9722_c", {
        model: "runtime-fallback-test/child-late",
      })),
    ).toThrow(/child-late/)
    expect(sessions).toEqual([])
  }, 30_000)
})
