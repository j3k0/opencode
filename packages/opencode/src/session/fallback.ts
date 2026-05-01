export class CooldownManager {
  private store = new Map<string, number>()

  private key(providerID: string, modelID: string): string {
    return `${providerID}/${modelID}`
  }

  put(providerID: string, modelID: string, durationMs: number): void {
    this.store.set(this.key(providerID, modelID), Date.now() + durationMs)
  }

  isCooledDown(providerID: string, modelID: string): boolean {
    const expiry = this.store.get(this.key(providerID, modelID))
    if (expiry === undefined) return false
    if (Date.now() >= expiry) {
      this.store.delete(this.key(providerID, modelID))
      return false
    }
    return true
  }

  clear(providerID: string, modelID: string): void {
    this.store.delete(this.key(providerID, modelID))
  }
}


