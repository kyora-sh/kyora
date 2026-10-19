import type { Socket, TCPSocketListener } from "bun"

interface Side {
  peer: Socket<Side> | null
  /** bytes for this socket its kernel buffer had no room for yet */
  pending: Uint8Array[]
  /** what the client sent before the upstream connection was up */
  early: Uint8Array[]
}

export interface CutProxy {
  url: string
  /** connections accepted so far */
  connections: number
  /** drops every connection open right now, both ends at once: to the client, a reset network */
  cut(): number
  stop(): void
}

/** writes what it can now and keeps the rest for the socket's drain, so nothing is dropped */
function send(socket: Socket<Side>, chunk: Uint8Array): void {
  if (socket.data.pending.length > 0) {
    socket.data.pending.push(chunk)
    return
  }
  const written = socket.write(chunk)
  if (written < chunk.length) socket.data.pending.push(chunk.subarray(Math.max(0, written)))
}

function drain(socket: Socket<Side>): void {
  while (socket.data.pending.length > 0) {
    const chunk = socket.data.pending[0]!
    const written = socket.write(chunk)
    if (written < chunk.length) {
      socket.data.pending[0] = chunk.subarray(Math.max(0, written))
      return
    }
    socket.data.pending.shift()
  }
}

/**
 * A TCP proxy in front of a fake server that can cut every connection through it at
 * once, the way a network that goes away (or a restarting host behind a tunnel) does:
 * mid-request or mid-response, with no HTTP answer at all.
 */
export function startCutProxy(target: string): CutProxy {
  const { hostname, port } = new URL(target)
  const open = new Set<Socket<Side>>()
  let listener: TCPSocketListener<Side>
  const proxy: CutProxy = {
    url: "",
    connections: 0,
    cut() {
      const sockets = [...open]
      for (const socket of sockets) {
        open.delete(socket)
        socket.terminate()
      }
      return sockets.length
    },
    stop() {
      proxy.cut()
      listener.stop(true)
    },
  }
  listener = Bun.listen<Side>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        proxy.connections++
        client.data = { peer: null, pending: [], early: [] }
        open.add(client)
        void Bun.connect<Side>({
          hostname,
          port: Number(port),
          socket: {
            open(upstream) {
              upstream.data = { peer: client, pending: [], early: [] }
              open.add(upstream)
              client.data.peer = upstream
              for (const chunk of client.data.early) send(upstream, chunk)
              client.data.early = []
            },
            data: (upstream, chunk) => {
              if (upstream.data.peer) send(upstream.data.peer, new Uint8Array(chunk))
            },
            drain,
            close(upstream) {
              open.delete(upstream)
              upstream.data.peer?.end()
            },
            error(upstream) {
              open.delete(upstream)
              upstream.data.peer?.terminate()
            },
          },
        }).catch(() => client.terminate())
      },
      data(client, chunk) {
        if (client.data.peer) send(client.data.peer, new Uint8Array(chunk))
        else client.data.early.push(new Uint8Array(chunk))
      },
      drain,
      close(client) {
        open.delete(client)
        client.data.peer?.end()
      },
      error(client) {
        open.delete(client)
        client.data.peer?.terminate()
      },
    },
  })
  proxy.url = `http://127.0.0.1:${listener.port}`
  return proxy
}
