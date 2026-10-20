import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'sdk-build-'))
const command = (cmd: string, args: string[], cwd: string, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 180000 })
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')}\n${result.stdout}${result.stderr}`)
  return result.stdout
}
try {
  for (const dir of ['sdk', 'sdk-py']) cpSync(join(root, dir), join(scratch, dir), { recursive: true, filter: path => !/(\/dist|\/node_modules|\/__pycache__)(\/|$)/.test(path) })
  const pkg = JSON.parse(readFileSync(join(scratch, 'sdk/package.json'), 'utf8'))
  assert.equal(pkg.name, 'mercury-cli-sdk'); assert.equal(pkg.version, '0.1.0'); assert.equal(pkg.license, 'Apache-2.0'); assert.notEqual(pkg.private, true)
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0)
  assert(pkg.exports['./testing'].types)
  symlinkSync(join(root, 'node_modules'), join(scratch, 'sdk/node_modules'))
  command('node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(scratch, 'sdk/tsconfig.json')], scratch)
  rmSync(join(scratch, 'sdk/node_modules'))
  const loaded = command('node', ['--input-type=module', '-e', `import {run,connect,ROW_TYPES} from ${JSON.stringify(join(scratch, 'sdk/dist/index.js'))}; if(typeof run!=='function'||typeof connect!=='function'||!ROW_TYPES.length)process.exit(1)`], scratch)
  for (const name of readdirSync(join(scratch, 'sdk/src')).filter(n => n.endsWith('.ts'))) {
    assert(readdirSync(join(scratch, 'sdk/dist')).includes(name.replace('.ts', '.d.ts')))
    const source = readFileSync(join(scratch, 'sdk/dist', name.replace('.ts', '.js')), 'utf8')
    for (const m of source.matchAll(/from ['"]([^'"]+)['"]/g)) assert(m[1]!.startsWith('node:') || m[1]!.startsWith('./'), m[1])
  }
  command('python3', ['-I', '-S', join(scratch, 'sdk-py/build_backend.py'), join(scratch, 'artifacts')], scratch)
  const wheel = readdirSync(join(scratch, 'artifacts')).find(f => f.endsWith('.whl'))!
  command('python3', ['-I', '-S', '-c', `import sys,zipfile;sys.path.insert(0,${JSON.stringify(join(scratch, 'artifacts', wheel))});import mercury_cli_sdk as s;assert s.__version__=='0.1.0';assert len(s.ROW_SCHEMAS)==25;assert callable(s.connect_sync);z=zipfile.ZipFile(sys.path[0]);assert 'mercury_cli_sdk/py.typed' in z.namelist();assert b'Requires-Dist:' not in z.read('mercury_cli_sdk-0.1.0.dist-info/METADATA')`], scratch)
  const sdist = readdirSync(join(scratch, 'artifacts')).find(f => f.endsWith('.tar.gz'))!
  mkdirSync(join(scratch, 'unpack'))
  command('python3', ['-I', '-S', '-c', `import tarfile;tarfile.open(${JSON.stringify(join(scratch, 'artifacts', sdist))}).extractall(${JSON.stringify(join(scratch, 'unpack'))},filter='data')`], scratch)
  command('python3', ['-I', '-S', join(scratch, 'unpack/mercury_cli_sdk-0.1.0/build_backend.py'), join(scratch, 'rebuilt')], scratch)
  assert.deepEqual(readFileSync(join(scratch, 'artifacts', wheel)), readFileSync(join(scratch, 'rebuilt', wheel)))
  assert(!loaded.includes('error'))
  console.log('PASS clean-copy TypeScript build; dependency-free Node import; Python stdlib-only wheel, sdist and identical rebuild; py.typed')
} finally { rmSync(scratch, { recursive: true, force: true }) }
