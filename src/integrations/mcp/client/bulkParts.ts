import { normalizeNameForMCP } from '../../mcp-shapes/normalization.js'
import type { ScopedMcpServerConfig } from '../../mcp-shapes/mcpServerRecords.js'

export async function runWithLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++] as T
      await work(item)
    }
  })
  await Promise.all(workers)
}

export type McpPrefixCollision = { name: string; config: ScopedMcpServerConfig; winner: string; error: string }

export function fenceMcpPrefixCollisions(configs: Record<string, ScopedMcpServerConfig>): {
  survivors: Record<string, ScopedMcpServerConfig>
  collided: McpPrefixCollision[]
} {
  const prefixOwners = new Map<string, string>()
  const survivors = Object.create(null) as Record<string, ScopedMcpServerConfig>
  const collided: McpPrefixCollision[] = []
  for (const [name, config] of Object.entries(configs)) {
    const folded = normalizeNameForMCP(name)
    const winner = prefixOwners.get(folded)
    if (winner === undefined) {
      prefixOwners.set(folded, name)
      survivors[name] = config
      continue
    }
    collided.push({
      name,
      config,
      winner,
      error: `its tool prefix collides with '${winner}' (both normalise to mcp__${folded}__) — rename one server; only '${winner}' was connected`,
    })
  }
  return { survivors, collided }
}
