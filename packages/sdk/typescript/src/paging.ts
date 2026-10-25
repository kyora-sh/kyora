import { KyoraError } from "./errors.js"
import type { WaitOptions } from "./http.js"

/** One page of a listing. `nextCursor` is set while more rows follow; pass it as `cursor`. */
export interface ListPage<T> {
  items: T[]
  nextCursor: string | null
}

export interface ListOptions extends WaitOptions {
  /** every pair must match (`label=key=value` on the wire) */
  labels?: Record<string, string>
  /** the most rows a page holds, 1 to 1000 (kyora's default is 500) */
  limit?: number
  /** the nextCursor of the previous page */
  cursor?: string
}

/** label pairs as the `label` query parameter repeats them */
export function labelQuery(labels: Record<string, string> | undefined): string[] | undefined {
  if (!labels) return undefined
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`)
}

/** rows that carry every pair: a server that ignored the filter never widens a listing */
export function matching<T extends { labels?: Record<string, string> | null }>(rows: T[], labels: Record<string, string> | undefined): T[] {
  if (!labels) return rows
  const pairs = Object.entries(labels)
  return rows.filter((row) => pairs.every(([key, value]) => row.labels?.[key] === value))
}

/**
 * Every row of a listing, page by page, from `cursor` on. A cursor that comes back again ends it
 * with an error instead of looping, so a partial listing is never passed off as the whole.
 */
export async function* follow<T>(operation: string, fetchPage: (cursor: string | undefined) => Promise<ListPage<T>>, cursor?: string): AsyncGenerator<T> {
  const seen = new Set<string>()
  for (;;) {
    const page = await fetchPage(cursor)
    yield* page.items
    if (!page.nextCursor) return
    if (seen.has(page.nextCursor)) throw new KyoraError({ code: "bad_response", status: 0, message: `${operation}: the server answered the same next_cursor twice`, operation })
    seen.add(page.nextCursor)
    cursor = page.nextCursor
  }
}
