import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const FIXTURE_API_KEY = 'fixture-key-000'

if (import.meta.main) {
  const [home, ...cwds] = process.argv.slice(2)
  if (home) seedFirstRun(home, cwds)
}

export function canonicalProjectKeyOf(cwd: string): string | null {
  const probe = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (probe.status !== 0) return null
  const common = probe.stdout.trim()
  if (common === '') return null
  const root = basename(common) === '.git' ? dirname(common) : common
  try {
    return realpathSync(root).normalize('NFC')
  } catch {
    return root.normalize('NFC')
  }
}

export function seedFirstRun(configHome: string, trustedCwds: string[]): void {
  const cfg = join(configHome, '.mercury.json')
  if (existsSync(cfg)) return
  mkdirSync(configHome, { recursive: true })
  const projects: Record<string, unknown> = {}
  for (const cwd of trustedCwds) {
    const keyOf = (dir: string): string => (process.platform === 'win32' ? dir.replace(/\\/g, '/') : dir)
    const canonical = canonicalProjectKeyOf(cwd)
    for (const key of new Set([keyOf(cwd), ...(canonical !== null ? [keyOf(canonical)] : [])])) {
      projects[key] = {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      }
    }
  }
  const envKey = process.env.ANTHROPIC_API_KEY
  const approved = [...new Set([...(envKey ? [envKey.slice(-20)] : []), FIXTURE_API_KEY.slice(-20)])]
  const customApiKeyResponses = { customApiKeyResponses: { approved, rejected: [] } }
  writeFileSync(
    cfg,
    JSON.stringify(
      {
        theme: 'dark',
        hasCompletedOnboarding: true,
        projects,
        ...customApiKeyResponses,
        switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
      },
      null,
      2,
    ) + '\n',
  )
}
