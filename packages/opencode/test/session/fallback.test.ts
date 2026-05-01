import { describe, expect, test } from "bun:test"
import { isRetryable, resolveFallback, CooldownManager } from "../../src/session/fallback"
import type { FallbackEntry } from "../../src/session/fallback"
import { MessageV2 } from "../../src/session/message-v2"

describe("CooldownManager", () => {
  test("isCooledDown returns false when no cooldown has been set", () => {
    const manager = new CooldownManager()
    expect(manager.isCooledDown("ollama", "glm-5.1:cloud")).toBe(false)
  })

  test("isCooledDown returns true after put and false after expiry", async () => {
    const manager = new CooldownManager()
    manager.put("ollama", "glm-5.1:cloud", 100)
    expect(manager.isCooledDown("ollama", "glm-5.1:cloud")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(manager.isCooledDown("ollama", "glm-5.1:cloud")).toBe(false)
  })

  test("clear removes a cooldown entry", () => {
    const manager = new CooldownManager()
    manager.put("ollama", "glm-5.1:cloud", 60000)
    expect(manager.isCooledDown("ollama", "glm-5.1:cloud")).toBe(true)
    manager.clear("ollama", "glm-5.1:cloud")
    expect(manager.isCooledDown("ollama", "glm-5.1:cloud")).toBe(false)
  })

  test("put updates an existing cooldown with a new expiry", async () => {
    const manager = new CooldownManager()
    manager.put("ollama", "glm-5.1:cloud", 60000)
    manager.put("ollama", "glm-5.1:cloud", 100)
    expect(manager.isCooledDown("ollama", "glm-5.1:cloud")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(manager.isCooledDown("ollama", "glm-5.1:cloud")).toBe(false)
  })

  test("isCooledDown returns false for unknown provider/model", () => {
    const manager = new CooldownManager()
    manager.put("ollama", "glm-5.1:cloud", 60000)
    expect(manager.isCooledDown("opencode-go", "glm-5.1")).toBe(false)
  })
})

describe("isRetryable", () => {
  test("returns false for context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({ message: "" }).toObject()
    expect(isRetryable(error)).toBe(false)
  })

  test("returns true for 5xx status codes", () => {
    const error = new MessageV2.APIError({
      statusCode: 503,
      isRetryable: false,
      responseHeaders: {},
      responseBody: "Service Unavailable",
      message: "Service Unavailable",
      metadata: {},
    }).toObject()
    expect(isRetryable(error)).toBe(true)
  })

  test("returns true for 429 status codes", () => {
    const error = new MessageV2.APIError({
      statusCode: 429,
      isRetryable: true,
      responseHeaders: {},
      responseBody: "Too Many Requests",
      message: "Too Many Requests",
      metadata: {},
    }).toObject()
    expect(isRetryable(error)).toBe(true)
  })

  test("returns false for non-retryable API errors", () => {
    const error = new MessageV2.APIError({
      statusCode: 401,
      isRetryable: false,
      responseHeaders: {},
      responseBody: "Unauthorized",
      message: "Unauthorized",
      metadata: {},
    }).toObject()
    expect(isRetryable(error)).toBe(false)
  })
})

describe("resolveFallback", () => {
  const chain: FallbackEntry[] = [
    { providerID: "opencode-go", modelID: "glm-5.1" },
    { providerID: "deepseek", modelID: "deepseek-v4-flash" },
  ]

  test("returns first fallback when no cooldowns active", () => {
    const cooldown = new CooldownManager()
    expect(resolveFallback(chain, cooldown)).toEqual(chain[0])
  })

  test("skips cooled-down fallbacks", () => {
    const cooldown = new CooldownManager()
    cooldown.put("opencode-go", "glm-5.1", 60000)
    expect(resolveFallback(chain, cooldown)).toEqual(chain[1])
  })

  test("returns undefined when all fallbacks are cooled down", () => {
    const cooldown = new CooldownManager()
    cooldown.put("opencode-go", "glm-5.1", 60000)
    cooldown.put("deepseek", "deepseek-v4-flash", 60000)
    expect(resolveFallback(chain, cooldown)).toBeUndefined()
  })
})
