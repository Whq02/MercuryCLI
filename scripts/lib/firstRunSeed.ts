// scripts/lib/firstRunSeed.ts — the ONE first-run seed for proof captures
//
//
// A FRESH config home boots the owned Onboarding flow (theme +
// hasCompletedOnboarding gates in interactiveHelpers) and an untrusted cwd
// boots the trust dialog — either way a PTY capture reads "no chrome". The
// operator's real onboarded home masked this dependency on the calibration
// machine forever. Seeding is ABSENT-ONLY: an existing global config file is
// NEVER touched (a real home stays byte-identical); a fresh one gets the
// minimal onboarded state + trust for the capture's boot cwd(s).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** The fixture server's canonical proof key — the spelling ~40 capture
 *  provers hand their boot; approved by every seeded home (below). */
export const FIXTURE_API_KEY = 'fixture-key-000'

// CLI form (the gate runner seeds each per-suite scratch home):
//   bun run scripts/lib/firstRunSeed.ts <configHome> <trustedCwd>...
if (import.meta.main) {
  const [home, ...cwds] = process.argv.slice(2)
  if (home) seedFirstRun(home, cwds)
}

/** The product keys a project's config slice by its CANONICAL git root
 *  (src/utils/config/projectConfig.ts → findCanonicalGitRoot): the repo
 *  root when the folder is inside one, and for a LINKED WORKTREE the MAIN
 *  worktree's root (the common dir's parent; a bare common dir stands for
 *  itself). A capture booted in a lane worktree therefore reads the main
 *  checkout's slice — a seed keyed on the worktree path alone never reached
 *  it, the first-run hint ("Run /init to create a MERCURY.md…") replaced
 *  the composer's idle placeholder, and every send gated on 'Type a prompt'
 *  landed undelivered (exit 4) in every worktree that lacks a MERCURY.md.
 *  Best effort by design: outside a repo, or without git, there is no
 *  second key and the raw cwd stays the only one. */
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
    // The product keys projects through normalizePathForConfigKey
    // (src/utils/path.ts) — forward slashes on EVERY platform. Seeding the
    // raw Windows path (backslashes) writes a key the trust walk can never
    // match, so every capture boots the blocking trust gate instead of the
    // composer. Platform-guarded: a literal
    // backslash is a legal character in a POSIX directory name.
    const keyOf = (dir: string): string => (process.platform === 'win32' ? dir.replace(/\\/g, '/') : dir)
    // The raw spelling AND the product's own key for it (the canonical git
    // root, see above) — one record each; the same folder keyed once.
    const canonical = canonicalProjectKeyOf(cwd)
    for (const key of new Set([keyOf(cwd), ...(canonical !== null ? [keyOf(canonical)] : [])])) {
      projects[key] = {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      }
    }
  }
  // A proof context carries its credential as ANTHROPIC_API_KEY (the CI job
  // env / scratch homes) — a fresh home would ask "use this custom API key?"
  // over every capture. Record the approval the way the product does
  // (normalizeApiKeyForConfig = the key's last 20 chars).
  // …and the CHILD's key is not always the seeder's: a capture prover hands
  // its boot `ANTHROPIC_API_KEY: 'fixture-key-000'` (the fixture server's
  // canonical proof key, scripts-wide) inside the child env AFTER seeding, so
  // an approval of the parent's key alone leaves the boot on the "Detected
  // a custom API key — use it?" card and every gated send undelivered
  // (the first run of prove-split-view-look). The seed
  // approves the canonical fixture key beside the env key. Absent-only
  // still holds: a real home is never written, so no operator home ever
  // carries the proof approval.
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
        // The concourse's one-time capacity ask (needsCapacityAsk) fires on
        // any home without a recorded decision and its modal sits over the
        // board, eating the capture's list/enter sends. Seed a CONSENTED
        // reading (never re-asked) so a seeded home is a WALKED home for the
        // switchboard too. The fixture states its own machine: five seats,
        // honoured as-is — a declined record would read the live machine
        // and make every multi-seat prover depend on the box it runs on.
        switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
      },
      null,
      2,
    ) + '\n',
  )
}
