import type { ManagedChildEvent } from "./child-handle"

/**
 * The provider/model a child event says the child is running on (#9722). Two carriers: an
 * in-process assistant message (`message.provider` + `message.model`), and an rpc-runner
 * `model_change`/`model_select` notification. Anything else is not a model observation, and an
 * event naming only one half is ignored - a partial observation must never rewrite the record.
 */
export function readObservedModel(event: ManagedChildEvent): { readonly provider: string; readonly modelId: string } | undefined {
  const fromMessage = readMessageModel(event.message)
  if (fromMessage !== undefined) return fromMessage
  if (event.type !== "model_change" && event.type !== "model_select") return undefined
  const provider = readStringField(event, "provider")
  const modelId = readStringField(event, "modelId") ?? readStringField(event, "model_id") ?? readStringField(event, "model")
  return provider === undefined || modelId === undefined ? undefined : { provider, modelId }
}

function readMessageModel(message: ManagedChildEvent["message"]): { readonly provider: string; readonly modelId: string } | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const provider = readStringField(message, "provider")
  const modelId = readStringField(message, "model")
  return provider === undefined || modelId === undefined ? undefined : { provider, modelId }
}

function readStringField(record: object, key: string): string | undefined {
  const value = Reflect.get(record, key)
  return typeof value === "string" && value.length > 0 ? value : undefined
}
