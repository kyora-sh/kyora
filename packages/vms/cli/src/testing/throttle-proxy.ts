import type { Socket, TCPSocketListener } from "bun"

/** a direction's queue past which the sending side is paused, so TCP pushes back on it */
const HIGH = 1024 * 1024
/** how much a direction may send at once after being idle: 20 ms worth */
const BURST_MS = 20

interface Link {
  pair: Pair
}

interface Pair {
  client: Socket<Link>
  upstream: Socket<Link> | null
  /** client → upstream */
  up: Pipe
  /** upstream → client */
  down: Pipe | null
}

/** one direction of a connection, handed on at most `rate` bytes a second */
class Pipe {
  private queue: Uint8Array[] = []
  private queued = 0
  private tokens = 0
  private last = performance.now()
  private timer: ReturnType<typeof setTimeout> | null = null
  private blocked = false
  private paused = false
  private ended = false
  to: Socket<Link> | null = null

  constructor(
    private readonly from: Socket<Link>,
    private readonly rate: number,
  ) {}

  push(chunk: Uint8Array): void {
    this.queue.push(chunk)
    this.queued += chunk.byteLength
    if (!this.paused && this.queued > HIGH) {
      this.paused = true
      this.from.pause()
    }
    this.pump()
  }

  end(): void {
    this.ended = true
    this.pump()
  }

  drained(): void {
    this.blocked = false
    this.pump()
  }

  pump(): void {
    if (!this.to || this.blocked || this.timer) return
    const now = performance.now()
    this.tokens = Math.min((this.rate * BURST_MS) / 1000, this.tokens + ((now - this.last) * this.rate) / 1000)
    this.last = now
    while (this.queue.length > 0) {
      if (this.tokens < 1) {
        const wait = Math.max(1, ((Math.min(this.queued, (this.rate * BURST_MS) / 1000) - this.tokens) / this.rate) * 1000)
        this.timer = setTimeout(() => {
          this.timer = null
          this.pump()
        }, wait)
        break
      }
      const head = this.queue[0]!
      const size = Math.min(head.byteLength, Math.floor(this.tokens))
      const written = this.to.write(head.subarray(0, size))
      if (written <= 0) {
        this.blocked = written === 0
        break
      }
      this.tokens -= written
      this.queued -= written
      if (written === head.byteLength) this.queue.shift()
      else this.queue[0] = head.subarray(written)
      if (written < size) {
        this.blocked = true
        break
      }
    }
    if (this.paused && this.queued < HIGH / 2) {
      this.paused = false
      this.from.resume()
    }
    if (this.queue.length === 0 && this.ended) this.to.end()
  }
}

/**
 * A TCP relay that caps every connection at `bytesPerSecond` each way: one connection's
 * throughput, the thing parallel parts and ranges are there to get around. Benchmarks put
 * it in front of the fake platform.
 */
export class ThrottleProxy {
  private readonly pairs = new Set<Pair>()
  private readonly listener: TCPSocketListener<Link>

  constructor(
    private readonly upstreamPort: number,
    readonly bytesPerSecond: number,
  ) {
    const self = this
    this.listener = Bun.listen<Link>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(client) {
          const pair: Pair = { client, upstream: null, up: new Pipe(client, bytesPerSecond), down: null }
          client.data = { pair }
          self.pairs.add(pair)
          void Bun.connect<Link>({
            hostname: "127.0.0.1",
            port: self.upstreamPort,
            socket: {
              open(upstream) {
                upstream.data = { pair }
                pair.upstream = upstream
                pair.down = new Pipe(upstream, bytesPerSecond)
                pair.down.to = client
                pair.up.to = upstream
                pair.up.pump()
              },
              data(_upstream, chunk) {
                pair.down?.push(new Uint8Array(chunk))
              },
              drain() {
                pair.up.drained()
              },
              close() {
                pair.down?.end()
                self.pairs.delete(pair)
              },
              error() {
                pair.client.end()
              },
            },
          }).catch(() => client.end())
        },
        data(client, chunk) {
          client.data.pair.up.push(new Uint8Array(chunk))
        },
        drain(client) {
          client.data.pair.down?.drained()
        },
        close(client) {
          client.data?.pair.up.end()
        },
        error(client) {
          client.data?.pair.upstream?.end()
        },
      },
    })
  }

  get port(): number {
    return this.listener.port
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  stop(): void {
    for (const pair of this.pairs) {
      pair.client.terminate()
      pair.upstream?.terminate()
    }
    this.pairs.clear()
    this.listener.stop(true)
  }
}
