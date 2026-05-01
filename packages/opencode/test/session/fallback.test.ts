import { describe, expect, test } from "bun:test"
import { isRetryable, resolveFallback, CooldownManager } from "../../src/session/fallback"
import type { FallbackEntry } from "../../src/session/fallback"

describe("CooldownManager", () => {
  test("isCooledDown returns false when no cooldown has been set", () => {
    const manager = new CooldownManager()
    expect(manager.isCooledDown("ollama", "glm-5.1")).toBe(false)
  })

  test("isCooledDown returns true after put and false after expiry", async () => {
    const manager = new CooldownManager()
    manager.put("ollama", "glm-5.1", 100)
    expect(manager.isCooledDown("ollama", "glm-5.1")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(manager.isCooledDown("ollama", "glm-5.1")).toBe(false)
  })

  test("clear removes a cooldown entry", () => {
    const manager = new CooldownManager()
    manager.put("ollama", "glm-5.1", 60000)
    expect(manager.isCooledDown("ollama", "glm-5.1")).toBe(true)
    manager.clear("ollama", "glm-5.1")
    expect(manager.isCooledDown("ollama", "glm-5.1")).toBe(false)
  })

  test("put updates an existing cooldown with a new expiry", async () => {
    const manager = new CooldownManager()
    manager.put("ollama", "glm-5.1", 60000)
    manager.put("ollama", "glm-5.1", 100)
    expect(manager.isCooledDown("ollama", "glm-5.1")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(manager.isCooledDown("ollama", "glm-5.1")).toBe(false)
  })

  test("isCooledDown returns false for unknown provider/model", () => {
    const manager = new CooldownManager()
    manager.put("ollama", "glm-5.1", 60000)
    expect(manager.isCooledDown("opencode", "unknown")).toBe(false)
  })
})

describe("resolveFallback", () => {
  const chain: FallbackEntry[] = [
    { providerID: "opencode", modelID: "glm-5.1" },
    { providerID: "deepseek", modelID: "deepseek-v4" },
  ]

  test("returns first fallback when no cooldowns active", () => {
    const cooldown = new CooldownManager()
    expect(resolveFallback(chain, cooldown)).toEqual(chain[0])
  })

  test("skips cooled-down fallbacks", () => {
    const cooldown = new CooldownManager()
    cooldown.put("opencode", "glm-5.1", 60000)
    expect(resolveFallback(chain, cooldown)).toEqual(chain[1])
  })

  test("returns undefined when all fallbacks are cooled down", () => {
    const cooldown = new CooldownManager()
    cooldown.put("opencode", "glm-5.1", 60000)
    cooldown.put("deepseek", "deepseek-v4", 60000)
    expect(resolveFallback(chain, cooldown)).toBeUndefined()
  })
})

describe("fallback config validation", () => {
  test("agent config accepts fallbacks array", () => {
    const { ConfigParse } = require("../../src/config/parse")
    const { Info: AgentInfo } = require("../../src/config/agent")
    const parsed = ConfigParse.effectSchema(AgentInfo, {
      model: "ollama/glm-5.1",
      fallbacks: ["opencode/glm-5.1", "deepseek/deepseek-v4"],
    }, "test")
    expect(parsed.fallbacks).toEqual(["opencode/glm-5.1", "deepseek/deepseek-v4"])
  })

  test("agent config works without fallbacks", () => {
    const { ConfigParse } = require("../../src/config/parse")
    const { Info: AgentInfo } = require("../../src/config/agent")
    const parsed = ConfigParse.effectSchema(AgentInfo, {
      model: "ollama/glm-5.1",
    }, "test")
    expect(parsed.fallbacks).toBeUndefined()
  })

  test("top-level config accepts fallbacks and cooldown_seconds", () => {
    const { ConfigParse } = require("../../src/config/parse")
    const { Info: ConfigInfo } = require("../../src/config/config")
    const parsed = ConfigParse.effectSchema(ConfigInfo, {
      model: "ollama/glm-5.1",
      fallbacks: ["opencode/glm-5.1"],
      cooldown_seconds: 120,
    }, "test")
    expect(parsed.fallbacks).toEqual(["opencode/glm-5.1"])
    expect(parsed.cooldown_seconds).toBe(120)
  })

  test("top-level config works without fallback fields", () => {
    const { ConfigParse } = require("../../src/config/parse")
    const { Info: ConfigInfo } = require("../../src/config/config")
    const parsed = ConfigParse.effectSchema(ConfigInfo, {
      model: "ollama/glm-5.1",
    }, "test")
    expect(parsed.fallbacks).toBeUndefined()
  })
})
