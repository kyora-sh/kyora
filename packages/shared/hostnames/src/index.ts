import { getDomain, parse } from "tldts"

/**
 * The egress hostname rules the kyora-vms CLI, kyora-vmd and kyora cloud all check against.
 */

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`)

/** Shared user policy validation, including IDNA conversion and private suffix boundaries. */
export function normalizeEgressHost(raw: string): string | null {
  const input = raw.trim().toLowerCase().replace(/\.$/, "")
  if (!input || /[\s/:@?#%\\]/.test(input)) return null
  let host: string
  try {
    host = new URL(`https://${input}`).hostname
  } catch {
    return null
  }
  if (host.length > 253 || !HOSTNAME.test(host) || /^[0-9]+$/.test(host.split(".").at(-1)!)) return null
  // `--` in positions three and four stays allowed outside xn--: real hosts use it (r3---sn-abc.googlevideo.com)
  return host
}

/**
 * A hostname's registrable domain when it sits below a suffix the Public Suffix List knows (ICANN or
 * private section), else null: IPs, bare suffixes (co.uk, github.io) and unlisted TLDs (.local, .internal).
 */
export function registrableDomain(host: string): string | null {
  const parsed = parse(host, { allowPrivateDomains: true })
  if (parsed.isIp || !(parsed.isIcann || parsed.isPrivate)) return null
  return parsed.domain ?? null
}

export function normalizeEgressEntry(raw: string, legacy = false): string | null {
  const input = raw.trim().toLowerCase()
  const wildcard = input.startsWith("*.")
  const host = normalizeEgressHost(wildcard ? input.slice(2) : input)
  if (!host || (host !== "blob.core.windows.net" && (!getDomain(host, { allowPrivateDomains: !legacy }) || (wildcard && !getDomain(`probe.${host}`, { allowPrivateDomains: !legacy }))))) return null
  return wildcard ? `*.${host}` : host
}

export function userEgressAllow(value: unknown, admin = false, publicDomain = "kyora.run"): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32) throw new Error("egressAllow must be an array of at most 32 hostnames")
  const hosts = new Set<string>()
  const domain = normalizeEgressHost(publicDomain)
  for (const entry of value) {
    const host = typeof entry === "string" ? normalizeEgressEntry(entry) : null
    if (!host) throw new Error("egressAllow takes exact hostnames or *.suffix below a public suffix, not IPs or bare TLDs")
    if (!admin && host.startsWith("*.")) {
      const suffix = host.slice(2)
      if (["kyora.run", domain].some((name) => name && (name === suffix || name.endsWith(`.${suffix}`)))) {
        throw new Error("egressAllow may name public URL labels exactly, but may not wildcard the public URL domain")
      }
    }
    hosts.add(host)
  }
  return [...hosts]
}

/** A wildcard's entire suffix must fit within an existing wildcard grant. */
export function egressSubset(next: string[], previous: string[]): boolean {
  return next.every((host) => previous.some((old) => old === host || (old.startsWith("*.") && (host.startsWith("*.") ? host.slice(1).endsWith(old.slice(1)) : host.endsWith(old.slice(1))))))
}

export interface EgressPolicy {
  network: "none" | "registries"
  egressAllow: string[]
}

export interface EgressChange {
  network?: "none" | "registries"
  egressAllow?: string[]
}
