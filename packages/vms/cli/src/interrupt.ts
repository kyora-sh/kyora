import { note } from "./output"

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const
type Handled = keyof typeof SIGNALS

export class Interrupted extends Error {
  constructor(readonly signal: Handled) {
    super(`interrupted by ${signal}`)
  }
}

/**
 * The first Ctrl-C (or SIGTERM from an agent's tool timeout) aborts whatever
 * request is in flight (dropping the exec stream is what makes the host kill the
 * remote process group) and lets the caller still destroy the sandbox. A second
 * one exits on the spot.
 */
export class Interrupt {
  private readonly controller = new AbortController()
  private readonly listeners: [Handled, () => void][] = []
  code: number | null = null

  constructor() {
    for (const signal of Object.keys(SIGNALS) as Handled[]) {
      const listener = () => this.fire(signal)
      process.on(signal, listener)
      this.listeners.push([signal, listener])
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get interrupted(): boolean {
    return this.code !== null
  }

  throwIfInterrupted(): void {
    if (this.controller.signal.aborted) throw this.controller.signal.reason
  }

  private fire(signal: Handled): void {
    if (this.code !== null) {
      note(`${signal} again: exiting without cleanup`)
      process.exit(this.code)
    }
    this.code = 128 + SIGNALS[signal]
    note(`${signal}: stopping the remote command and cleaning up (send it again to exit now)`)
    this.controller.abort(new Interrupted(signal))
  }

  dispose(): void {
    for (const [signal, listener] of this.listeners) process.off(signal, listener)
  }
}
