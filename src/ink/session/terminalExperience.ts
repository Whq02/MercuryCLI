
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export type ExperienceSource = 'canonical-env' | 'default'

export interface ResolvedExperienceControl {
  effective: boolean
  source: ExperienceSource
}

export interface TerminalExperienceResolution {
  terminalTitle: ResolvedExperienceControl
  accessibility: ResolvedExperienceControl
  virtualScroll: ResolvedExperienceControl
}

function positiveControl(canonical: string, defaultOn: boolean): ResolvedExperienceControl {
  const c = flagEnv(canonical)
  if (c !== undefined) return { effective: c !== '0', source: 'canonical-env' }
  return { effective: defaultOn, source: 'default' }
}

function positiveOptIn(canonical: string, defaultOn: boolean): ResolvedExperienceControl {
  const c = flagEnv(canonical)
  if (c !== undefined) return { effective: c !== '0' && isEnvTruthy(c), source: 'canonical-env' }
  return { effective: defaultOn, source: 'default' }
}

export function resolveTerminalExperience(): TerminalExperienceResolution {
  return {
    terminalTitle: positiveControl('MERCURY_TERMINAL_TITLE', true),
    accessibility: positiveOptIn('MERCURY_ACCESSIBILITY', false),
    virtualScroll: positiveControl('MERCURY_VIRTUAL_SCROLL', true),
  }
}
