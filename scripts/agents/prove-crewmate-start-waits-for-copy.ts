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

const paths = sceneRoot('crewmate-start-waits-')
const root = realpathSync(paths.root)
const repo = join(root, 'workspace')
const seenAt = join(root, 'seen.txt')
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const LOOK = `node -e ${quote('let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const fs=require("fs");const d=JSON.parse(s).directory;let seen="absent";try{seen=fs.lstatSync(d+"/node_modules").isSymbolicLink()?"link":fs.existsSync(d+"/node_modules/pkg-299/f99.js")?"whole":"partial"}catch{}fs.writeFileSync(process.argv[1],seen+" "+d)})')} ${quote(seenAt)}`

try {
  section('a crewmate.start hook looks at the directory its crewmate works in')
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
      hooks: { 'crewmate.start': [{ name: 'look', run: `${LOOK}; ${say({ context: 'the copy was looked at' })}` }] },
      beforeRun: () => {
        git('init', '-q', '-b', 'main')
        writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.mercury/\n')
        writeFileSync(join(repo, 'package.json'), '{"name":"start-hook"}\n')
        git('add', '.gitignore', 'package.json')
        git('commit', '-q', '-m', 'first')
        for (let pkg = 0; pkg < 300; pkg++) {
          mkdirSync(join(repo, 'node_modules', `pkg-${pkg}`), { recursive: true })
          for (let index = 0; index < 100; index++) writeFileSync(join(repo, 'node_modules', `pkg-${pkg}`, `f${index}.js`), `module.exports = ${pkg * 100 + index}\n`)
        }
      },
    },
  )
  const seen = existsSync(seenAt) ? readFileSync(seenAt, 'utf8') : '<the hook wrote nothing>'
  const [state, directory] = [seen.split(' ')[0] ?? '', seen.split(' ').slice(1).join(' ')]
  const lanes = existsSync(join(repo, '.mercury', 'worktrees')) ? readdirSync(join(repo, '.mercury', 'worktrees')).filter(name => name.startsWith('agent-')) : []
  console.log(`  the hook saw: ${state} in ${directory.replace(root, '<root>')}`)
  check('the run ends well and the hook\'s words reach the crewmate', result.code === 0 && result.wire.some(request => JSON.stringify(request.body).includes('the copy was looked at')), result.stderr.slice(-300))
  check('the hook was given the crewmate\'s worktree', lanes.length === 1 && realpathSync(directory) === realpathSync(join(repo, '.mercury', 'worktrees', lanes[0] as string)), `${directory} | ${lanes.join(', ')}`)
  if (clones) check('the hook found the dependency folder whole: it runs once the copy is ready, as it did when the launch waited', state === 'whole', seen)
  else {
    skip('this volume or platform does not clone: the dependency folder is the link')
    check('the hook found the link to the checkout\'s dependency folder in place', state === 'link', seen)
  }
  check('the copy holds the folder at the end', lanes.length === 1 && lstatSync(join(repo, '.mercury', 'worktrees', lanes[0] as string, 'node_modules')).isDirectory())
} finally {
  try {
    execFileSync('chmod', ['-R', 'u+rwx', root])
  } catch {
  }
  rmSync(root, { recursive: true, force: true })
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
