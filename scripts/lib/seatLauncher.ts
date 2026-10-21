import { existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BUN, DIST, NODE, REPO } from '../daemon/dupline-world.ts'

export type SeatRuntime = { exe: string; script: string; runtime: 'node' | 'bun'; from: 'the built product' | 'the source' }

export function prebuiltSeats(): boolean {
  return process.env.MERCURY_GATE_PREBUILT === '1'
}

export function sourceLauncher(dir: string, name = 'launcher.ts'): string {
  const launcher = join(dir, name)
  writeFileSync(launcher, `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }\ndelete process.env.NODE_ENV\nawait import(${JSON.stringify(join(REPO, 'src', 'entrypoints', 'cli.tsx'))})\n`)
  return launcher
}

export function seatRuntime(dir: string, opts: { source?: 'required'; name?: string } = {}): SeatRuntime {
  if (opts.source !== 'required' && prebuiltSeats()) {
    if (!existsSync(DIST)) throw new Error(`MERCURY_GATE_PREBUILT=1 names a built product, but ${DIST} is absent: the gate builds once before its shards; locally run bun run build.ts first`)
    return { exe: NODE, script: DIST, runtime: 'node', from: 'the built product' }
  }
  return { exe: BUN, script: sourceLauncher(dir, opts.name), runtime: 'bun', from: 'the source' }
}

export function describeSeat(seat: SeatRuntime): string {
  return `${seat.from} under ${seat.runtime} (${seat.exe} ${basename(seat.script)})`
}
