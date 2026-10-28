import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Command } from 'commander'
import { registerTuneDoor, tuneDoor, TUNE_DOOR_HELP } from '../../src/cli/tuneDoor.ts'

const home = join(proofHome, 'program'), invocations: Array<{ command: string; args: string[]; cwd: string; inherit: boolean }> = []
let failBuild = false
const execute = async (command: string, args: string[], cwd: string, inherit: boolean): Promise<number> => {
  invocations.push({ command, args, cwd, inherit })
  if (command === 'git') {
    mkdirSync(join(cwd, 'bin')); mkdirSync(join(cwd, 'dist'))
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'mercury-tune', bin: { 'mercury-tune': 'bin/mercury-tune.mjs' } }))
    writeFileSync(join(cwd, 'bin/mercury-tune.mjs'), 'console.log(JSON.stringify({args:process.argv.slice(2),pid:process.pid})); process.exitCode=Number(process.env.FIXTURE_TUNE_EXIT??0)\n')
    writeFileSync(join(cwd, 'dist/cli.mjs'), '')
    return 0
  }
  if (command === 'bun') return failBuild && args[0] === 'run' ? 1 : 0
  const child = spawnSync('node', args, { cwd, encoding: 'utf8', env: { ...process.env, FIXTURE_TUNE_EXIT: '7' } })
  const output = JSON.parse(child.stdout)
  assert.notEqual(output.pid, process.pid)
  assert.deepEqual(output.args, ['export', '--out', 'folder with spaces', '--flag=$value'])
  return child.status!
}
await assert.rejects(tuneDoor(['export'], { home, execute }), /Install Tune with/)
await assert.rejects(tuneDoor(['--repository', 'https://user:secret@example.com/repo'], { home, execute }), /without credentials/)
assert.equal(invocations.length, 0)
const args = ['export', '--out', 'folder with spaces', '--flag=$value']
assert.equal(await tuneDoor(['--repository', 'https://example.com/tune.git', ...args], { home, execute }), 7)
assert.deepEqual(invocations.slice(0, 3).map(row => [row.command, row.args.slice(0, 2)]), [['git', ['clone', '--depth']], ['bun', ['install', '--frozen-lockfile']], ['bun', ['run', 'build']]])
assert.equal(invocations.at(-1)!.inherit, true)
const before = readFileSync(join(home, 'current.json'), 'utf8')
invocations.length = 0
assert.equal(await tuneDoor(args, { home, execute }), 7)
assert.equal(invocations.length, 1)
failBuild = true
await assert.rejects(tuneDoor(['--update', ...args], { home, execute }), /previous installation is unchanged/)
assert.equal(readFileSync(join(home, 'current.json'), 'utf8'), before)
assert.equal(await tuneDoor(args, { home, execute }), 7)
console.log('PASS door: separate child, exact argv and exit code, explicit repository, no reinstall, atomic failed update')

const cli = new Command('mercury').enablePositionalOptions().exitOverride()
registerTuneDoor(cli, async () => {})
const command = cli.commands[0]!
assert.equal(command.description(), TUNE_DOOR_HELP)
assert.equal(TUNE_DOOR_HELP, 'Train your own model on your own sessions')
let passed: string[] = []
command.action((args: string[]) => { passed = args })
await cli.parseAsync(['tune', 'export', '--out', 'folder with spaces', '--help'], { from: 'user' })
assert.deepEqual(passed, ['export', '--out', 'folder with spaces', '--help'])
assert.ok(command.helpInformation().includes('--repository <git-url>'))
assert.ok(command.helpInformation().includes('--update'))
console.log('PASS registered help and subcommand flags pass through without core interpretation')
