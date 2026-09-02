import { spawnSync } from 'node:child_process'
import path from 'node:path'

export type TarPathApi = Pick<typeof path, 'basename' | 'dirname' | 'relative' | 'isAbsolute' | 'sep'>

export type TarSpawnPlan = {
  args: string[]
  cwd: string
  forceLocal: boolean
}

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
  const forceLocal = input.isGnuTar()
  return {
    args: ['-xzf', input.tarballPath, '-C', input.destDir, ...stripArgs, ...(forceLocal ? ['--force-local'] : [])],
    cwd,
    forceLocal,
  }
}

let gnuProbe: boolean | null = null

export function tarIsGnu(): boolean {
  if (gnuProbe === null) {
    const probe = spawnSync('tar', ['--version'], { encoding: 'utf8', env: process.env })
    gnuProbe = typeof probe.stdout === 'string' && probe.stdout.includes('GNU tar')
  }
  return gnuProbe
}

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
