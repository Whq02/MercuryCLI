import type { CheckSpec } from '../healthReport.js'

export function nativeOwnershipChecks(): CheckSpec[] {
  return [
    {
      id: 'terminal-runtime',
      label: 'Terminal runtime',
      run: async () => {
        const { getCellLayoutCounters } = await import('../../../screen/renderer/layout/cellLayout.js')
        const c = getCellLayoutCounters()
        return {
          status: 'ok' as const,
          evidence: `Mercury Cell Layout (owned, bedrock B2) — last pass: ${c.visited} visited · ${c.measured} measured · ${c.cacheHits} cache hits · ${c.live} live nodes`,
        }
      },
    },
  ]
}
