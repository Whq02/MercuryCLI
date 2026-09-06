import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bigWordmarkRows } from '../../src/components/mercury-ui/assets.js'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts/ui/vshot.py')
const CONFIG_HOME = resolveProofHome([REPO.normalize('NFC')])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(REPO.normalize('NFC')))
const SID = `00000000-aaaa-bbbb-eeee-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`

const base = (extra: Record<string, unknown>) => ({
  isSidechain: false, entrypoint: 'cli',
  cwd: REPO, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
})
const lines: unknown[] = []
let prev: string | null = null
for (let i = 1; i <= 30; i++) {
  const uuid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  lines.push(base({
    parentUuid: prev, type: 'user', uuid,
    message: { role: 'user', content: `turn ${i}: probe message body padding the row out for realism` },
    timestamp: `2026-06-19T12:00:${String(i).padStart(2, '0')}.000Z`,
  }))
  prev = uuid
}
if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
const fixture = join(PROJECTS, `${SID}.jsonl`)
writeFileSync(fixture, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

const PAGEUP = '\x1b[5~'
const sends = Array.from({ length: 16 }, (_, i) => ({ atTick: 45 + i * 2, data: PAGEUP }))
const grid = '/tmp/scroll-session-lock-grid.json'
const commits = '/tmp/scroll-session-lock-commits.jsonl'
const cfgPath = '/tmp/scroll-session-lock-cfg.json'
writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--resume', SID], sends, total: 90, cols: 120, rows: 44, out: grid }))
try { rmSync(commits) } catch {  }
const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf-8', timeout: vshotBudgetMs(150000),
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    MERCURY_LIVE_GLYPHS: '0',
    INK_COMMIT_TEE: commits,
  },
})
try { rmSync(fixture) } catch {  }
if (res.status !== 0) {
  console.error(`✗ vshot failed: ${res.stderr?.slice(0, 300)}`)
  process.exit(1)
}

const g = JSON.parse(readFileSync(grid, 'utf8'))
const rows: string[] = g.grid.map((line: Array<{ c: string }>) => line.map(c => c.c).join(''))
const joined = rows.join('\n')
let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}
const halfBlocks = (joined.match(/[▀▄]/g) ?? []).length
check(halfBlocks >= 60, `critter hero visible after PageUp spam (${halfBlocks} half-block cells)`)
check(joined.includes(bigWordmarkRows()[0]!.trimEnd()), 'banner-header visible with the hero')
check(!joined.includes('mission control'), 'landing tagline stays collapsed')
check(joined.includes('turn 1:'), 'first message on screen below the header')
const commitLines = readFileSync(commits, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const tail = commitLines.filter(c => c.scroll?.top !== undefined).slice(-3)
check(
  tail.length > 0 && tail.every(c => c.scroll.top === 0),
  `scrollTop rests at the natural top (${JSON.stringify(tail.at(-1)?.scroll)})`,
)
console.log(failures === 0 ? '✅ scroll-to-top hero GREEN' : `❌ scroll-to-top hero RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
