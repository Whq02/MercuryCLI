// ============================================================================
//  healthDeployedAssets — the deployed-asset drift assessment.
// The config home carries COPIES of repo artifacts — the
//  launcher (scripts/ops/deploy-launcher.sh → <config-home>/bin/mercury) and
//  the enter screen (scripts/splash/deploy.sh → $MERCURY_HOME/splash.mjs) —
//  both deployed as plain syntax-checked `cp`, so byte-equality against the
//  repo canon IS the freshness oracle (the launcher's managed splash-action
//  block is kept in sync with assets/splash/launcher-action-block.sh, so a
//  splash-deploy refresh never legitimately diverges the copy).
//
//  Why a certificate leg: a drifted deployed copy is exactly how the
//  "old UI" incident hid, and how the pre-rebrand welcome.py
//  banner survived a month past the rebrand — the stale-deployed-artifact
//  class. /health now sees it.
//
//  PURE module: node:fs + node:path only — bun-loadable by the proof
//  (scripts/health/prove-deployed-assets.ts) with fixture homes.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** repo-canonical → config-home deployed copy; redeploy = the fix command. */
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
  // the splash deploys as a PAIR — the
  // driver imports './splash-core.mjs' from the same home, so a stale or
  // missing core is exactly the drift class this certificate leg hunts.
  {
    label: 'splash-core',
    repoRel: 'assets/splash/splash-core.mjs',
    homeRel: 'splash-core.mjs',
    redeploy: 'bash scripts/splash/deploy.sh',
  },
] as const

/** Byte-patcher files that must not linger in the config home: the launcher
 *  boots the deployed runtime as built, so their presence is cruft at best
 *  and a stale-runtime seam at worst. */
export const RETIRED_HOME_ARTIFACTS = [
  'patches.json', // byte-patcher state
  'patches.d', // byte-patcher payloads
] as const

export interface DeployedAssetsAssessment {
  status: 'ok' | 'warn' | 'stale' | 'info'
  evidence: string
  fix?: string
  /** drifted pairs, for the W8 remedy (redeploy commands, repo-rooted) */
  drifted: Array<{ label: string; redeploy: string }>
  /** retired artifacts found in the home (home-relative names) */
  cruft: string[]
}

function bytesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

/**
 * Assess the config home's deployed copies against the repo canon.
 * `repoRoot` = the source checkout (caller verifies it looks like one);
 * `home` = the config home ($MERCURY_HOME).
 */
export function assessDeployedAssets(repoRoot: string, home: string): DeployedAssetsAssessment {
  const matched: string[] = []
  const undeployed: string[] = []
  const drifted: Array<{ label: string; redeploy: string }> = []
  for (const pair of DEPLOYED_ASSET_PAIRS) {
    const repoPath = join(repoRoot, pair.repoRel)
    const homePath = join(home, pair.homeRel)
    if (!existsSync(repoPath)) continue // partial checkout — nothing to compare
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
