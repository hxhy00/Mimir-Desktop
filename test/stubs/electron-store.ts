/** electron-store 桩：内存实现，仅覆盖 get/set。 */
export default class ElectronStore<T extends Record<string, unknown>> {
  private data: Record<string, unknown>

  constructor(opts?: { defaults?: Record<string, unknown> }) {
    this.data = { ...(opts?.defaults ?? {}) } as Record<string, unknown>
    this.store = this.data
  }

  store: Record<string, unknown>

  get<K extends keyof T & string>(key: K, def?: unknown): unknown {
    const v = this.data[key]
    return v === undefined ? def : v
  }

  set(key: string | Record<string, unknown>, value?: unknown): void {
    if (typeof key === 'object' && key !== null) {
      Object.assign(this.data, key)
    } else {
      this.data[key] = value
    }
    this.store = this.data
  }

  has(key: string): boolean {
    return this.data[key] !== undefined
  }

  delete(key: string): void {
    delete this.data[key]
  }
}
