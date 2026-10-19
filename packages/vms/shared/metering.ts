// SPDX-License-Identifier: Apache-2.0
export const METER_COUNTERS = ["cpuUsec", "memMbSeconds", "netRxBytes", "netTxBytes", "diskUsedBytes"] as const
export type MeterCounter = (typeof METER_COUNTERS)[number]
export const BURST_COUNTERS = ["burstCpuUsec", "burstMemMbSeconds"] as const
export type BurstCounter = (typeof BURST_COUNTERS)[number]
export type CounterMarks = Record<MeterCounter, number | null> & Partial<Record<BurstCounter, number | null>>

export interface MeterClock {
  lifetime: string
  generation: string
  sequence: number
  elapsedMs: number
  hibernatedMs?: number
  clockGaps: number
  resets: number
  diskByteSeconds: number
  diskGapMs: number
  verified: CounterMarks
  anchors: CounterMarks
  gaps: Record<MeterCounter, number> & Partial<Record<BurstCounter, number>>
}

export const meterNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
export const counterGrowth = (value: number, mark: number): number => Math.max(0, value - mark)
export const counterMarks = (): CounterMarks => Object.fromEntries(METER_COUNTERS.map((counter) => [counter, null])) as CounterMarks

export function reportOrder(generation: unknown, sequence: unknown): { generation: string; sequence: number } | null {
  return typeof generation === "string" && generation.length > 0 && generation.length <= 128 && Number.isSafeInteger(sequence) && Number(sequence) > 0 ? { generation, sequence: Number(sequence) } : null
}

export function hourShares(start: number, end: number): Array<[hour: number, share: number]> {
  const hourMs = 3_600_000
  if (end <= start) return [[Math.floor(end / hourMs) * hourMs, 1]]
  const shares: Array<[number, number]> = []
  for (let hour = Math.floor(start / hourMs) * hourMs; hour < end; hour += hourMs) {
    const overlap = Math.min(end, hour + hourMs) - Math.max(start, hour)
    if (overlap > 0) shares.push([hour, overlap / (end - start)])
  }
  return shares
}

export function elapsedInterval(previous: number, current: number, limit = Infinity): { elapsed: number; missing: number; reset: boolean } {
  const reset = meterNumber(previous) === null || meterNumber(current) === null || current < previous
  const elapsed = reset ? 0 : Math.min(current - previous, limit)
  return { elapsed, missing: reset ? 0 : current - previous - elapsed, reset }
}

export function readMeterClock(raw: unknown): MeterClock | null {
  if (typeof raw !== "object" || raw === null) return null
  const value = raw as Record<string, unknown>
  if (![value.lifetime, value.generation].every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) return null
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) return null
  if (![value.elapsedMs, value.clockGaps, value.diskByteSeconds, value.diskGapMs].every((n) => meterNumber(n) !== null)) return null
  if (value.hibernatedMs !== undefined && (meterNumber(value.hibernatedMs) === null || Number(value.hibernatedMs) > Number(value.elapsedMs))) return null
  if (value.resets !== undefined && (!Number.isSafeInteger(value.resets) || Number(value.resets) < 0)) return null
  const marks = (raw: unknown, nullable: boolean): boolean => typeof raw === "object" && raw !== null && METER_COUNTERS.every((counter) => {
    const mark = (raw as Record<string, unknown>)[counter]
    return nullable && mark === null || Number.isSafeInteger(mark) && Number(mark) >= 0 && (!nullable || Number(mark) <= Number(value.sequence))
  })
  for (const counter of BURST_COUNTERS) {
    for (const field of ["verified", "anchors", "gaps"]) {
      const mark = (value[field] as Record<string, unknown> | undefined)?.[counter]
      if (mark !== undefined && !(field !== "gaps" && mark === null) && (!Number.isSafeInteger(mark) || Number(mark) < 0 || field !== "gaps" && Number(mark) > Number(value.sequence))) return null
    }
  }
  if (!marks(value.verified, true) || !marks(value.anchors, true) || !marks(value.gaps, false)) return null
  return {
    lifetime: value.lifetime as string, generation: value.generation as string, sequence: Number(value.sequence),
    elapsedMs: Number(value.elapsedMs), clockGaps: Number(value.clockGaps), resets: Number(value.resets ?? 0), diskByteSeconds: Number(value.diskByteSeconds), diskGapMs: Number(value.diskGapMs),
    ...(value.hibernatedMs === undefined ? {} : { hibernatedMs: Number(value.hibernatedMs) }),
    verified: { ...value.verified as CounterMarks }, anchors: { ...value.anchors as CounterMarks }, gaps: { ...value.gaps as MeterClock["gaps"] },
  }
}

export function meterInterval(previous: MeterClock | null, current: MeterClock | null): { elapsed: number; baseline: boolean; replay: boolean; clock: boolean; disk: boolean } {
  const same = previous !== null && current !== null && previous.lifetime === current.lifetime
  const replay = same && current.sequence <= previous.sequence
  const baseline = !same || previous.generation !== current.generation
  const interval = elapsedInterval(previous?.elapsedMs ?? NaN, current?.elapsedMs ?? NaN)
  return {
    elapsed: baseline || replay ? 0 : interval.elapsed,
    baseline, replay,
    clock: baseline || interval.reset || current!.clockGaps > previous!.clockGaps,
    disk: baseline || interval.reset || current!.diskGapMs > previous!.diskGapMs || current!.gaps.diskUsedBytes > previous!.gaps.diskUsedBytes,
  }
}
