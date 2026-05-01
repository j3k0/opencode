import { describe, expect, test } from "bun:test"
import { CooldownManager } from "../../src/session/fallback"

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
