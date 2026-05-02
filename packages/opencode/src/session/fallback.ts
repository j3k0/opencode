import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"
import { ProviderID, ModelID } from "@/provider/schema"
import { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import type { Err } from "./retry"

export class CooldownManager {
  private store = new Map<string, number>()

  private key(providerID: string, modelID: string): string {
    return `${providerID}/${modelID}`
  }

  put(providerID: string, modelID: string, durationMs: number): void {
    this.store.set(this.key(providerID, modelID), Date.now() + durationMs)
  }

  isCooledDown(providerID: string, modelID: string): boolean {
    const k = this.key(providerID, modelID)
    const expiry = this.store.get(k)
    if (expiry === undefined) return false
    if (Date.now() >= expiry) {
      this.store.delete(k)
      return false
    }
    return true
  }

  clear(providerID: string, modelID: string): void {
    this.store.delete(this.key(providerID, modelID))
  }
}

export type FallbackEntry = {
  providerID: string
  modelID: string
}

export function isRetryable(error: Err): boolean {
  return SessionRetry.retryable(error) !== undefined
}

export const FallbackTriggered = BusEvent.define(
  "llm.fallback.triggered",
  Schema.Struct({
    sessionID: SessionID,
    modelID: ModelID,
    providerID: ProviderID,
    reason: Schema.String,
  }),
)
