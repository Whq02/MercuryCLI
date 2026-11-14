#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { quote, runDoor, say, sceneRoot } from '../hooks/lib/runDoor.ts'
import { cloneRoadExpected } from '../lib/cloneRoad.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const skip = (label: string): void => console.log(`  [SKIP] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

type Seen = { event: string; crewmate: string | null; dirs: Record<string, { path: string; seen: string }> }
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const LOOKER = 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const fs=require("fs");const p=JSON.parse(s);const out={event:p.event,crewmate:p.crewmate_id||null,dirs:{}};for(const k of ["cwd","directory","worktree_path"]){const d=p[k];if(typeof d!=="string")continue;let seen="absent";try{seen=fs.lstatSync(d+"/node_modules").isSymbolicLink()?"link":fs.existsSync(d+"/node_modules/pkg-299/f99.js")?"whole":"partial"}catch{}out.dirs[k]={path:d,seen}}fs.appendFileSync(process.argv[1],JSON.stringify(out)+"\\n")})'

const scene = async (name: string, events: readonly string[], answering: boolean): Promise<{ rows: Seen[]; lane: string | null; code: number | null; reached: boolean; stderr: string; clones: boolean; root: string }> => {
  const paths = sceneRoot(`crewmate-hooks-${name}-`)
  const root = realpathSync(paths.root)
  const repo = join(root, 'workspace')
  const seenAt = join(root, 'seen.jsonl')
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const look = `node -e ${quote(LOOKER)} ${quote(seenAt)}`
  try {
    const clones = cloneRoadExpected(root)
    const result = await runDoor(
      { home: join(root, 'home'), cwd: repo },
      {
        args: ['--mode', 'sovereign'],
        timeoutMs: 180_000,
        turns: [
          { kind: 'tool_use', name: 'Crewmate', id: 'isolated-helper', input: { description: 'isolated helper', prompt: 'say done', isolation: 'worktree' } },
          { kind: 'text', text: 'helper done' },
          { kind: 'text', text: 'parent done' },
          { kind: 'text', text: 'all done' },
        ],
        hooks: Object.fromEntries(events.map(event => [event, [{ name: `look at ${event}`, run: answering && event === 'crewmate.start' ? `${look}; ${say({ context: 'the copy was looked at' })}` : look }]])),
        beforeRun: () => {
          git('init', '-q', '-b', 'main')
          writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.mercury/\n')
          writeFileSync(join(repo, 'package.json'), '{"name":"hooks-in-a-copy"}\n')
          git('add', '.gitignore', 'package.json')
          git('commit', '-q', '-m', 'first')
          for (let pkg = 0; pkg < 300; pkg++) {
            mkdirSync(join(repo, 'node_modules', `pkg-${pkg}`), { recursive: true })
            for (let index = 0; index < 100; index++) writeFileSync(join(repo, 'node_modules', `pkg-${pkg}`, `f${index}.js`), `module.exports = ${pkg * 100 + index}\n`)
          }
        },
      },
    )
    const rows = existsSync(seenAt) ? readFileSync(seenAt, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Seen) : []
    const lanes = existsSync(join(repo, '.mercury', 'worktrees')) ? readdirSync(join(repo, '.mercury', 'worktrees')).filter(entry => entry.startsWith('agent-')) : []
    const lane = lanes.length === 1 ? join(repo, '.mercury', 'worktrees', lanes[0] as string) : null
    const ended = lane !== null && lstatSync(join(lane, 'node_modules')).isDirectory()
    return { rows, lane: ended || !clones ? lane : null, code: result.code, reached: result.wire.some(request => JSON.stringify(request.body).includes('the copy was looked at')), stderr: result.stderr.slice(-300), clones, root }
  } finally {
    try {
      execFileSync('chmod', ['-R', 'u+rwx', root])
    } catch {
    }
    rmSync(root, { recursive: true, force: true })
  }
}
const inCopy = (rows: readonly Seen[], lane: string | null): Array<{ event: string; field: string; seen: string }> =>
  rows.flatMap(row => Object.entries(row.dirs).filter(([, dir]) => lane !== null && dir.path === lane).map(([field, dir]) => ({ event: row.event, field, seen: dir.seen })))
const wanted = (clones: boolean): string => (clones ? 'whole' : 'link')

section('§1 a crewmate.start hook looks at the directory its crewmate works in')
const started = await scene('start', ['crewmate.start'], true)
const startLooks = inCopy(started.rows, started.lane)
console.log(`  the hook saw: ${startLooks.map(look => `${look.event} ${look.field} ${look.seen}`).join(', ') || 'nothing in the copy'}`)
check('the run ends well and the hook\'s words reach the crewmate', started.code === 0 && started.reached, started.stderr)
check('the hook was given the crewmate\'s worktree', startLooks.some(look => look.event === 'crewmate.start' && look.field === 'directory'), JSON.stringify(started.rows).slice(0, 300))
if (!started.clones) skip('this volume or platform does not clone: the dependency folder is the link, in place before the hook as before')
check('the hook found the dependency folder in place: it runs once the copy is ready, as it did when the launch waited', startLooks.length > 0 && startLooks.every(look => look.seen === wanted(started.clones)), JSON.stringify(startLooks))
check('the copy holds the folder at the end', started.lane !== null)

section('§2 the hooks of a crewmate that calls no tool: its answer, its turn\'s end, its own end')
const ended = await scene('end', ['turn.answer', 'turn.end', 'crewmate.end'], false)
const endLooks = inCopy(ended.rows, ended.lane)
console.log(`  the hooks saw: ${endLooks.map(look => `${look.event} ${look.field} ${look.seen}`).join(', ') || 'nothing in the copy'}`)
check('the run ends well', ended.code === 0 && ended.lane !== null, ended.stderr)
check('a turn.answer hook of the crewmate ran in its copy', endLooks.some(look => look.event === 'turn.answer'), JSON.stringify(ended.rows.map(row => [row.event, row.crewmate, Object.keys(row.dirs)])).slice(0, 300))
check('a crewmate.end hook was handed the copy', endLooks.some(look => look.event === 'crewmate.end' && look.field === 'worktree_path'), JSON.stringify(ended.rows.map(row => [row.event, row.crewmate, Object.keys(row.dirs)])).slice(0, 300))
check('every hook that looked into the copy found the dependency folder in place', endLooks.length > 0 && endLooks.every(look => look.seen === wanted(ended.clones)), JSON.stringify(endLooks))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
