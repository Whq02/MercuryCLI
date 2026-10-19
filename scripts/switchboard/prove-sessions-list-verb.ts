#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-list-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-list-proj-')))
const DAEMON = join(HOME, 'daemon')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON
mkdirSync(DAEMON, { recursive: true })
process.chdir(PROJ)

let failures = 0
let count = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  count++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const ROOT = resolve(import.meta.dir, '..', '..')
const source = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

const { getProjectDir, getProjectsDir } = await import('../../src/utils/sessionStorage/paths.ts')
const verb = (await import('../../src/cli/sessionsVerb.ts')) as { sessionsListCli?: (options: { all?: boolean; limit?: number }, io: unknown) => Promise<number> }

const STORE = getProjectDir(PROJ)
const OTHER_STORE = join(getProjectsDir(), '-other-project')
mkdirSync(STORE, { recursive: true })
mkdirSync(OTHER_STORE, { recursive: true })
const ids = { older: '11111111-1111-4111-8111-111111111111', newer: '22222222-2222-4222-8222-222222222222', elsewhere: '33333333-3333-4333-8333-333333333333' }
const line = (sessionId: string, stamp: string, words: string): string =>
  JSON.stringify({ type: 'user', sessionId, uuid: `${sessionId}-u1`, timestamp: stamp, cwd: PROJ, message: { role: 'user', content: words } }) + '\n'
const seed = (store: string, sessionId: string, stamp: string, words: string, title?: string): void => {
  const path = join(store, `${sessionId}.jsonl`)
  let body = line(sessionId, stamp, words)
  if (title !== undefined) body += JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }) + '\n'
  writeFileSync(path, body)
}
seed(STORE, ids.older, '2026-10-01T00:00:00.000Z', 'fix the login page')
seed(STORE, ids.newer, '2026-10-02T00:00:00.000Z', 'write the release notes', 'release notes for .39')
seed(OTHER_STORE, ids.elsewhere, '2026-10-03T00:00:00.000Z', 'another project entirely')

const run = async (options: { all?: boolean; limit?: number }): Promise<{ code: number; out: string[]; err: string[] }> => {
  const out: string[] = []
  const err: string[] = []
  const code = verb.sessionsListCli === undefined ? -1 : await verb.sessionsListCli(options, { out: (l: string) => out.push(l), err: (l: string) => err.push(l), interactive: false, ask: async () => false })
  return { code, out, err }
}

try {
  section("§1 `mercury sessions list` names this project's saved sessions, newest first, with the id the other doors take (the field row M39-10)")
  {
    const result = await run({})
    check('the verb exists and exits 0', result.code === 0, JSON.stringify(result))
    check('both of this project\'s sessions are listed, newest first, and the other project\'s is not', result.out.findIndex(l => l.startsWith(ids.newer)) === 1 && result.out.findIndex(l => l.startsWith(ids.older)) === 2 && !result.out.some(l => l.startsWith(ids.elsewhere)), result.out.join('\n'))
    check('a row carries the id, the modified stamp, the size and the title or first prompt', result.out.some(l => l.startsWith(ids.newer) && /\d{4}-\d{2}-\d{2}T/.test(l) && / KB/.test(l) && l.includes('release notes for .39')) && result.out.some(l => l.startsWith(ids.older) && l.includes('fix the login page')), result.out.join('\n'))
    check('the footer names --resume and sessions delete as the doors the id opens', result.out.at(-1)?.includes('--resume <id>') === true && result.out.at(-1)?.includes('sessions delete <id>') === true, result.out.at(-1) ?? '')
  }
  section('§2 --all reads every project; --limit bounds the list')
  {
    const all = await run({ all: true })
    check('--all lists the other project\'s session too', all.code === 0 && all.out.some(l => l.startsWith(ids.elsewhere)) && all.out.some(l => l.startsWith(ids.newer)), all.out.join('\n'))
    const one = await run({ limit: 1 })
    check('--limit 1 lists the newest only', one.code === 0 && one.out.filter(l => /^[0-9a-f-]{36} /.test(l)).length === 1 && one.out.some(l => l.startsWith(ids.newer)), one.out.join('\n'))
  }
  section('§3 the words and the door agree: --help names the listing, a bare `sessions` lists instead of printing the delete help and failing')
  {
    const main = source('src/main.tsx')
    check("the sessions command's description names list and delete", main.includes("description('Saved sessions: list, delete')"))
    check('a bare `sessions` runs the listing (an action on the parent command)', /command\('sessions'\)[\s\S]{0,900}\.action\(async \(options: \{ all\?: boolean; limit\?: number \}\) => \{\s*const \{ sessionsListCli \}/.test(main))
    check('`sessions list` is a sub-command with --all and --limit', main.includes(".command('list')") && main.includes("'--all', 'List the saved sessions of every project, not only this one'"))
    const readme = source('README.md')
    check('the README names `mercury sessions list`', readme.includes('`mercury sessions list`'))
  }
} finally {
  rmSync(HOME, { recursive: true, force: true })
  rmSync(PROJ, { recursive: true, force: true })
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('SESSIONS LIST VERB RED')
  process.exit(1)
}
console.log('SESSIONS LIST VERB GREEN')
