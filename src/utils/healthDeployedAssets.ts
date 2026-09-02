import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEPLOYED_ASSET_PAIRS = [
  {
    label: 'launcher',
    repoRel: 'scripts/ops/launcher-mercury.sh',
    homeRel: 'bin/mercury',
    redeploy: 'bash scripts/ops/deploy-launcher.sh',
  },
  {
    label: 'splash',
    repoRel: 'assets/splash/mercury-splash.mjs',
    homeRel: 'splash.mjs',
    redeploy: 'bash scripts/splash/deploy.sh',
  },
  {
    label: 'splash-core',
    repoRel: 'assets/splash/splash-core.mjs',
    homeRel: 'splash-core.mjs',
    redeploy: 'bash scripts/splash/deploy.sh',
  },
] as const

export const RETIRED_HOME_ARTIFACTS = [
  'patches.json',
  'patches.d',
] as const

export interface DeployedAssetsAssessment {
  status: 'ok' | 'warn' | 'stale' | 'info'
  evidence: string
  fix?: string
  drifted: Array<{ label: string; redeploy: string }>
  cruft: string[]
}

function bytesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

export function assessDeployedAssets(repoRoot: string, home: string): DeployedAssetsAssessment {
  const matched: string[] = []
  const undeployed: string[] = []
  const drifted: Array<{ label: string; redeploy: string }> = []
  for (const pair of DEPLOYED_ASSET_PAIRS) {
    const repoPath = join(repoRoot, pair.repoRel)
    const homePath = join(home, pair.homeRel)
    if (!existsSync(repoPath)) continue
    if (!existsSync(homePath)) {
      undeployed.push(pair.label)
      continue
    }
    if (bytesEqual(repoPath, homePath)) {
      matched.push(pair.label)
    } else {
      drifted.push({ label: pair.label, redeploy: pair.redeploy })
    }
  }
  const cruft = RETIRED_HOME_ARTIFACTS.filter(name => existsSync(join(home, name)))

  const parts: string[] = []
  if (matched.length > 0) parts.push(`${matched.join(' + ')} byte-match the repo canon`)
  if (drifted.length > 0)
    parts.push(`${drifted.map(d => d.label).join(' + ')} DRIFTED from the repo canon`)
  if (undeployed.length > 0) parts.push(`${undeployed.join(' + ')} not deployed`)
  if (cruft.length > 0) parts.push(`retired artifact(s) linger: ${cruft.join(', ')}`)

  if (drifted.length > 0) {
    return {
      status: 'stale',
      evidence: parts.join(' · '),
      fix: `Redeploy: ${drifted.map(d => d.redeploy).join(' && ')}`,
      drifted,
      cruft,
    }
  }
  if (cruft.length > 0) {
    return {
      status: 'warn',
      evidence: parts.join(' · '),
      fix: `Delete from ${home}: ${cruft.join(', ')} (the runtime boots as built — nothing is patched at launch)`,
      drifted,
      cruft,
    }
  }
  if (matched.length === 0) {
    return {
      status: 'info',
      evidence:
        undeployed.length > 0
          ? `nothing deployed to ${home} (direct-run setup) — drift n/a`
          : 'no comparable artifacts found — drift n/a',
      drifted,
      cruft,
    }
  }
  return { status: 'ok', evidence: parts.join(' · '), drifted, cruft }
}
