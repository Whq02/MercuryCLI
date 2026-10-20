import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'sdk-bundlers-'))
function run(command: string, args: string[], cwd = scratch) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`)
  return result.stdout
}
try {
  run('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'sdk/tsconfig.json')])
  mkdirSync(join(scratch, 'node_modules'), { recursive: true })
  cpSync(join(root, 'sdk'), join(scratch, 'node_modules/mercury-cli-sdk'), { recursive: true, filter: p => !p.includes('/node_modules/') && !p.includes('/src/') })
  const consumer = join(scratch, 'consumer.ts')
  writeFileSync(consumer, `import { run, connect, ROW_SCHEMAS, rowOf } from 'mercury-cli-sdk';
import { startFixtureServer } from 'mercury-cli-sdk/testing';
const unknown = rowOf({type:'future',extra:42});
if(!unknown.ok || unknown.row.type!=='unknown_row') throw Error('unknown row');
const fixture=await startFixtureServer({methods:{initialize:[{result:{protocol:1,runner:{version:'fixture',pid:1},session_id:'fixture'}}],'session/facts':[{result:{fixture:true}}]}});
try { const s=await connect({mercury:fixture.mercury}); try {if(!(await s.facts()).fixture) throw Error('facts')} finally {await s.close()} } finally {await fixture.close()}
if(typeof run !== 'function'||Object.keys(ROW_SCHEMAS).length!==25)throw Error('exports');
console.log('bundled consumer passed');`)
  run('bun', ['build', consumer, '--compile', '--outfile', join(scratch, 'consumer-bin')])
  let esbuild = process.env.ESBUILD_BINARY_PATH ?? join(root, 'node_modules/esbuild/bin/esbuild')
  if (!existsSync(esbuild)) {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(scratch, 'build-tools'), '--cache', join(scratch, 'npm-cache'), 'esbuild@0.28.2'])
    esbuild = join(scratch, 'build-tools/node_modules/.bin/esbuild')
  }
  run(esbuild, [consumer, '--bundle', '--platform=node', '--format=esm', `--outfile=${join(scratch, 'consumer.mjs')}`])
  rmSync(join(scratch, 'node_modules'), { recursive: true, force: true })
  rmSync(consumer)
  assert(run(join(scratch, 'consumer-bin'), []).includes('bundled consumer passed'))
  assert(run('node', [join(scratch, 'consumer.mjs')]).includes('bundled consumer passed'))
  console.log('PASS bun build --compile and esbuild: standalone consumers initialize the runner fixture with no source/package files remaining')
} finally { rmSync(scratch, { recursive: true, force: true }) }
