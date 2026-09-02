// ============================================================================
//  scripts/vendor/tarExtract.ts — the ONE tar invocation the vendor
//  fetches share.
//
//  The cross-box field root (E008-01 ↔ TASK-018 W1-build-path): a bare
//  `tar` handed a Windows ABSOLUTE path aborts under GNU tar, which
//  parses a leading `C:` as a remote host ("Cannot connect to C: resolve
//  failed") — so PATH order (Git Bash's GNU tar vs System32's bsdtar)
//  decided whether a checkout could fetch its vendor packs, and the build
//  shipped silently degraded. The dialect-proof invocation: run tar with
//  cwd set and RELATIVE forward-slash paths, so no argv token can carry a
//  drive colon and the host:path parsing never engages — on any dialect,
//  with no probe. Only when relativisation cannot shed a drive
//  (cross-drive) or a colon survives in a file name do we fall back to
//  absolute paths, appending GNU tar's own remedy --force-local exactly
//  when the probed dialect is GNU (bsdtar has no such flag and no such
//  parsing).
// ============================================================================
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export type TarPathApi = Pick<typeof path, 'basename' | 'dirname' | 'relative' | 'isAbsolute' | 'sep'>

export type TarSpawnPlan = {
  args: string[]
  cwd: string
  /** True on the fallback branch under a GNU dialect (the flag rides in args). */
  forceLocal: boolean
}

/**
 * The pure argument plan (injectable path api so the win32 shapes pin on
 * any box). The happy path never consults the dialect.
 */
export function planTarExtract(input: {
  tarballPath: string
  destDir: string
  stripComponents?: number
  pathApi?: TarPathApi
  isGnuTar: () => boolean
}): TarSpawnPlan {
  const p: TarPathApi = input.pathApi ?? path
  const strip = input.stripComponents ?? 0
  const stripArgs = strip > 0 ? ['--strip-components', String(strip)] : []
  const cwd = p.dirname(input.tarballPath)
  const tarArg = p.basename(input.tarballPath)
  const destRel = p.relative(cwd, input.destDir)
  const destArg = destRel === '' ? '.' : destRel.split(p.sep).join('/')
  if (!p.isAbsolute(destArg) && !tarArg.includes(':') && !destArg.includes(':')) {
    return { args: ['-xzf', tarArg, '-C', destArg, ...stripArgs], cwd, forceLocal: false }
  }
  // Relativisation could not shed a drive prefix, or a colon survives in
  // a file name — the one case the dialect matters.
  const forceLocal = input.isGnuTar()
  return {
    args: ['-xzf', input.tarballPath, '-C', input.destDir, ...stripArgs, ...(forceLocal ? ['--force-local'] : [])],
    cwd,
    forceLocal,
  }
}

let gnuProbe: boolean | null = null

/** One `tar --version` per process: GNU tar answers with its name. */
export function tarIsGnu(): boolean {
  if (gnuProbe === null) {
    // env passed explicitly: bun's spawnSync otherwise resolves the
    // executable against the PROCESS-START PATH, ignoring later
    // process.env.PATH changes (node honours them either way).
    const probe = spawnSync('tar', ['--version'], { encoding: 'utf8', env: process.env })
    gnuProbe = typeof probe.stdout === 'string' && probe.stdout.includes('GNU tar')
  }
  return gnuProbe
}

/**
 * Extract a .tgz into destDir (which must exist). Failure messages name
 * the real cause — a dialect fault reads as a dialect fault, never as a
 * network error.
 */
export function extractTarGz(input: { tarballPath: string; destDir: string; stripComponents?: number }): { ok: true } | { ok: false; message: string } {
  const plan = planTarExtract({ ...input, isGnuTar: tarIsGnu })
  const run = spawnSync('tar', plan.args, { cwd: plan.cwd, encoding: 'utf8', env: process.env })
  if (run.status === 0) return { ok: true }
  const stderr = (run.stderr ?? '').trim()
  const dialectHint = /Cannot connect|resolve failed/i.test(stderr)
    ? ' (a tar DIALECT fault, not a network one: GNU tar parses a drive-letter path as host:path — check which tar PATH resolves first)'
    : ''
  const cause = run.error ? String(run.error) : stderr !== '' ? stderr : `exit ${String(run.status)}`
  return { ok: false, message: `${cause.slice(0, 300)}${dialectHint}` }
}
