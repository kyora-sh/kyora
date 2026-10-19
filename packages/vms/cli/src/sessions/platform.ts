import type { VmsClient } from "../api"
import type { CredentialKind, SlotProvider } from "./slots"

/** kyora cloud's sessions API, as the CLI calls it */

export type CloudDriver = "cloud" | "local"
export type CloudState = "starting" | "running" | "stopped" | "ended"

export interface CloudSession {
  id: string
  name: string
  agent: string
  agentSession: string
  repo: string
  branch: string
  base: string
  sandboxId: string | null
  execId: string | null
  driver: CloudDriver
  state: CloudState
  /** the credential slot the broker uses now */
  slot: string | null
  lastCheckpoint: { commit: string | null; at: string; stored: boolean } | null
  children: string[]
  maxChildren: number
  ttlSeconds: number
  /** when its token stops working at the latest */
  expiresAt?: string
  createdAt: string
  endedAt: string | null
  endReason?: string | null
}

export interface SessionCreated {
  session: CloudSession
  /** the session token (kys_…), shown once: the broker's credential and the child token */
  token: string
  /** where the VM's agent sends model calls: `<origin>/v1/broker/anthropic` */
  broker: { anthropic: string }
  /** `<origin>/v1/sessions/<id>`, where the VM reports checkpoints */
  api: string
  limits: { maxTtlSeconds: number; maxChildren: number }
}

export interface NewSession {
  name: string
  agent: string
  agentSession: string
  repo: string
  branch: string
  base: string
  ttlSeconds: number
  maxChildren?: number
}

const path = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`

export const createSession = (api: VmsClient, body: NewSession) => api.call<SessionCreated>("start the session", "POST", "/v1/sessions", { json: body })
export const getSession = (api: VmsClient, id: string) => api.call<CloudSession>("read the session", "GET", path(id))
export const listSessions = (api: VmsClient) => api.call<{ sessions: CloudSession[] }>("list sessions", "GET", "/v1/sessions")
export const updateSession = (api: VmsClient, id: string, patch: Partial<Pick<CloudSession, "sandboxId" | "execId" | "driver" | "state">> & { mode?: string }) =>
  api.call<CloudSession>("update the session", "PATCH", path(id), { json: patch })
/** ends it: the token stops working, its children go, and with `destroy` its sandbox; slots it held are released */
export const endSession = (api: VmsClient, id: string, body: { destroy: boolean; reason: string }) =>
  api.call<{ session: CloudSession; destroyed: string[] }>("end the session", "POST", `${path(id)}/end`, { json: body })
/** the last checkpoint the VM reported, as the tar it sent (bundle, transcript, state) */
export const checkpointArchive = (api: VmsClient, id: string, signal?: AbortSignal) => api.fetchRaw("fetch the session's last checkpoint", `${path(id)}/checkpoint`, signal)

export interface CloudCredential {
  provider: SlotProvider
  name: string
  kind: CredentialKind
  fingerprint: string
  identity: { account?: string; org?: string; plan?: string }
  version: number
  /** the broker may refresh and use it; false once handed back */
  cloudOwned: boolean
  state: "ok" | "cooling" | "revoked"
  cooldownUntil: string | null
  lastError: string | null
  uploadedAt: string
  updatedAt: string
}

const credentialPath = (provider: string, name: string) => `/v1/credentials/${encodeURIComponent(provider)}/${encodeURIComponent(name)}`

export const putCredential = (
  api: VmsClient,
  provider: SlotProvider,
  name: string,
  body: {
    kind: CredentialKind
    credential: string
    fingerprint: string
    identity: CloudCredential["identity"]
    position?: number
    /** over a login the broker owns: the version this laptop put there (refused once the broker refreshed it) */
    expectVersion?: number
    /** over a login the broker owns, whatever it did with it */
    force?: boolean
  },
) => api.call<CloudCredential>(`upload credential ${provider}/${name}`, "PUT", credentialPath(provider, name), { json: body })

export const listCredentials = (api: VmsClient) => api.call<{ credentials: CloudCredential[] }>("list credentials", "GET", "/v1/credentials")
export const deleteCredential = (api: VmsClient, provider: SlotProvider, name: string) => api.call<void>(`delete credential ${provider}/${name}`, "DELETE", credentialPath(provider, name))
/** the hand-back: the latest (possibly rotated) credential, and the broker stops using it */
export const returnCredential = (api: VmsClient, provider: SlotProvider, name: string) =>
  api.call<{ credential: CloudCredential; value: string }>(`take credential ${provider}/${name} back`, "POST", `${credentialPath(provider, name)}/return`)
