/** The meter counters a sample carries, spelled out here so the published library's types stay inside its package. */
export type SampleCounter = "cpuUsec" | "memMbSeconds" | "netRxBytes" | "netTxBytes" | "diskUsedBytes"
type CounterMarks = Record<SampleCounter, number | null>
type CounterGaps = Record<SampleCounter, number>

export interface GuestUsage {
  memUsedMb?: number
  memTotalMb?: number
  diskUsedBytes?: number
  diskTotalBytes?: number
  at: number
  memAt?: number
  diskAt?: number
}

export interface SandboxSample {
  guest?: GuestUsage | null
  verifiedAt: CounterMarks | null
  gaps: CounterGaps | null
  sampledAt: number
  receivedAt: number
  startedAt: string
  cpuUsec: number | null
  memMbSeconds: number | null
  netRxBytes: number | null
  netTxBytes: number | null
  diskUsedBytes: number | null
  wallSeconds: number | null
  memoryMb: number | null
  memoryGapMs: number | null
  lifetime: string | null
  generation: string | null
  sequence: number | null
  resets: number | null
}

export interface SandboxStats {
  id: string
  name: string | null
  region: string
  vcpus: number
  memoryMb: number
  diskGb: number
  sample: SandboxSample | null
}

export interface SandboxStatsResponse {
  account: string
  at: number
  sandboxes: SandboxStats[]
}
