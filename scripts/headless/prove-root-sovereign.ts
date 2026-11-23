#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const modulePath = join(root, 'src/permissions/rules/rootNotice.ts')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
const notice = 'Running as root in sovereign mode: the agent can change any file on this machine without asking.\n'
for (const [uid, modes, expected] of [
  [0, ['sovereign'], notice],
  [1000, ['sovereign'], ''],
  [0, ['default', 'implement', 'flow', 'dontAsk', 'apollo'], ''],
  [0, ['default', 'sovereign', 'flow', 'sovereign'], notice],
] as const) {
  const result = spawnSync(process.execPath, ['-e', `process.getuid = () => ${uid}; const { noteRootSovereign } = await import(${JSON.stringify(modulePath)}); for (const mode of ${JSON.stringify(modes)}) noteRootSovereign(mode); console.log('continued')`], { env: process.env, encoding: 'utf8' })
  check(`uid ${uid} and ${modes.join('/')} continue with the one applicable notice`, result.status === 0 && result.stdout === 'continued\n' && result.stderr === expected, `${JSON.stringify(result)} - change noteRootSovereign in src/permissions/rules/rootNotice.ts so the notice prints to stderr once, only for uid 0 in sovereign mode, and the run continues`)
}
process.exit(failures === 0 ? 0 : 1)
