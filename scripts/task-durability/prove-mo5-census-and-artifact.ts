#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const mo5FailHint = 'section 2 exercises isolationCheck in src/platform/health/sections/crew/home.ts (its remedy must count a record only when the move landed); section 4 reads .github/workflows/windows-functional.yml (add scripts/task-durability/run-all.sh to it); section 5 reads the built dist/mercury.mjs, so rebuild with bun run build.ts after changing the persisted-through message in src/platform/substrate/durablePublish.ts, the file-in-use words in src/platform/host-os/words.ts or HELD_FILE_RETRY_DELAYS_MS in src/platform/host-os/files.ts'
const ok = (cond: boolean, label: string, detail = ''): void => {
  const shown = cond ? detail : detail ? `${detail}; ${mo5FailHint}` : mo5FailHint
  console.log(`  ${cond ? '✅' : '❌'} ${label}${shown ? ` — ${shown}` : ''}`)
  if (!cond) failures++
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
console.log('── mo5 census ratchet + artifact survival')


{
  const fsH = await import('node:fs')
  const { join: joinH } = await import('node:path')
  const { tmpdir: tmpH } = await import('node:os')
  const globals = globalThis as Record<string, unknown>
  if (globals.MACRO === undefined) globals.MACRO = { VERSION: '1.0.0' }
  const home = fsH.mkdtempSync(joinH(tmpH(), 'mo5-isolation-'))
  fsH.mkdirSync(joinH(home, 'daemon'), { recursive: true })
  fsH.writeFileSync(joinH(home, 'daemon', 'daemon.log'), 'Restarting dead daemon: /Users/op/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js\n')
  const homeBefore = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = home
  const envUtils = await import('../../src/platform/environment/envUtils.ts')
  const forget = (): void => (envUtils.getMercuryHome as unknown as { cache: { clear?: () => void } }).cache.clear?.()
  forget()
  const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
  const isolation = await crewChecks().find(row => row.id === 'isolation')?.run()
  const dest = /move the foreign records to (.+) \(reversible archive/.exec(isolation?.remedy?.plan ?? '')?.[1] ?? ''
  let blocked: { ok: boolean; note?: string } | undefined
  let moved: { ok: boolean; note?: string } | undefined
  if (dest !== '') {
    fsH.mkdirSync(joinH(dest, 'daemon_daemon.log', 'held'), { recursive: true })
    blocked = await isolation?.remedy?.apply()
    fsH.rmSync(joinH(dest, 'daemon_daemon.log'), { recursive: true, force: true })
    moved = await isolation?.remedy?.apply()
  }
  if (homeBefore === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = homeBefore
  forget()
  ok(
    isolation?.status === 'warn' && blocked?.ok === false && /^archive failed: (?!Error:)/.test(blocked.note ?? '') && (blocked.note ?? '').includes(joinH(home, 'daemon', 'daemon.log')) && moved?.ok === true && /archived 1 foreign record\(s\)/.test(moved.note ?? '') && fsH.statSync(joinH(dest, 'daemon_daemon.log')).isFile() && !fsH.existsSync(joinH(home, 'daemon', 'daemon.log')),
    `§2 the health isolation remedy counts a record only when its move landed (run here: blocked ${JSON.stringify(blocked)} · moved ${JSON.stringify(moved)})`,
  )
}


{
  const wf = read('.github/workflows/windows-functional.yml')
  ok(wf.includes('scripts/task-durability/run-all.sh'), '§4 windows-functional runs the task-durability suite (win32-native arms)')
}

{
  const distPath = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(distPath)) {
    console.log('  ⚠ §5 SKIPPED — dist/mercury.mjs absent (no build on this leg; the gate dist job + local builds carry the survival proof)')
  }
  if (existsSync(distPath)) {
    const dist = readFileSync(distPath, 'utf8')
    ok(dist.includes(' persisted through '), '§5 the typed-failure accounting message is in the bundle')
    ok(
      dist.includes('exclude the folder from real-time scanning'),
      '§5 the win32 file-in-use guidance is in the bundle',
    )
    ok(dist.includes('[50,100,200]') || dist.includes('[50, 100, 200]'), '§5 the retry schedule is in the bundle')
  }
}

console.log(failures === 0 ? '\nPASS prove-mo5-census-and-artifact' : `\nFAIL prove-mo5-census-and-artifact (${failures})`)
process.exit(failures === 0 ? 0 : 1)
