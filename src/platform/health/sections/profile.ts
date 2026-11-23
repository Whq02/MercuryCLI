import { getMercuryAppearanceSnapshot } from '../../../screen/widgets/appearanceSnapshot.js'
import { isDarkThemeFamily, listUnresolvedTokenRoles, resolveMercuryTokens } from '../../../screen/theme/mercuryTokens.js'
import { oasisBgEnabled } from '../../../screen/cockpit/oasisBg.js'
import { getBuiltInAgents } from '../../../tools/crewmate/builtInAgents.js'
import type { CheckSpec } from '../healthReport.js'

export function profileChecks(): CheckSpec[] {
  return [
    {
      id: 'appearance',
      label: 'Resolved appearance',
      run: () => {
        const a = getMercuryAppearanceSnapshot()
        const tokens = resolveMercuryTokens(a.concreteTheme, a.accent)
        const missing = listUnresolvedTokenRoles(tokens)
        const ground = oasisBgEnabled(Boolean(process.stdout.isTTY), a.concreteTheme)
          ? 'oasis ground painted'
          : isDarkThemeFamily(a.concreteTheme)
            ? 'ground off (env/TTY gate)'
            : 'profile ground'
        const evidence = `theme ${a.requestedTheme}${a.requestedTheme === 'auto' ? `→${a.concreteTheme}` : ''} · ${a.colorMode} · accent ${a.accent} · motion ${a.motion} · ${ground}`
        if (missing.length > 0) {
          return {
            status: 'fail' as const,
            evidence: `${evidence} — ${missing.length} unresolved semantic role(s): ${missing.join(',')}`,
            fix: 'A theme family resolved an empty token — chrome would lose contrast there. Report which family; /appearance to switch away meanwhile.',
            link: '/appearance',
          }
        }
        return { status: 'info' as const, evidence, link: '/appearance' }
      },
    },
    {
      id: 'roster-normalization',
      label: 'Agent roster',
      run: () => {
        const agents = getBuiltInAgents()
        const evidence = `${agents.length} built-in roles ship`
        return { status: 'ok' as const, evidence }
      },
    },
    {
      id: 'crew-launch',
      label: 'Crewmate launch',
      run: () => {
        return { status: 'info' as const, evidence: "in-process — crewmates run inside this session's runner", link: '/crewmates' }
      },
    },
  ]
}
