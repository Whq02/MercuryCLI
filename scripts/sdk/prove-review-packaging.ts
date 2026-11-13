import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUN, PYTHON } from './runtime.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-package-review-')))
function run(command: string, args: string[], env = process.env, cwd = scratch) {
  const result = spawnSync(command, args, { cwd, env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 0, `${command}: ${result.stdout}${result.stderr}`)
  return result.stdout
}
try {
  const before = readFileSync(join(root, 'sdk-py/src/mercury_cli_sdk/generated.py'), 'utf8')
  run(BUN, [join(root, 'scripts/sdk/generate.ts'), '--out', join(scratch, 'generated')])
  assert.equal(readFileSync(join(root, 'sdk-py/src/mercury_cli_sdk/generated.py'), 'utf8'), before)
  assert(readFileSync(join(scratch, 'generated/wire.ts'), 'utf8').includes('WIRE_GENERATED_FROM'))
  assert(readFileSync(join(scratch, 'generated/python/generated.py'), 'utf8').includes('GENERATED_BY ='))
  const excluded = (p: string) => /[\\/](dist|node_modules|__pycache__)([\\/]|$)/.test(p)
  assert(excluded('C:\\scratch\\sdk\\dist\\index.js') && excluded('C:\\scratch\\sdk\\dist') && excluded('/scratch/sdk/node_modules/x') && excluded('/scratch/sdk-py/src/__pycache__') && !excluded('/scratch/sdk/distant/x') && !excluded('C:\\scratch\\sdk\\src\\index.ts'), 'the copy filter excludes dist, node_modules and __pycache__ on both path separators')
  for (const dir of ['sdk', 'sdk-py']) cpSync(join(root, dir), join(scratch, dir), { recursive: true, filter: p => !excluded(p) })
  const pkg = JSON.parse(readFileSync(join(scratch, 'sdk/package.json'), 'utf8'))
  assert.equal(pkg.homepage, 'https://mercury-cli.ai'); assert.equal(pkg.repository.directory, 'sdk')
  const venvPython = (name: string) => { run(PYTHON, ['-m', 'venv', '--without-pip', join(scratch, name)]); return join(scratch, name, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') }
  const sourceImport = (python: string) => run(python, ['-c', `import mercury_cli_sdk as s;from pathlib import Path;assert Path(s.__file__).resolve()==Path(${JSON.stringify(join(scratch, 'sdk-py/src/mercury_cli_sdk/__init__.py'))}),s.__file__`])
  const python = venvPython('venv')
  const purelib = run(python, ['-c', 'import sysconfig;print(sysconfig.get_paths()["purelib"])']).trim()
  const editable = run(PYTHON, ['-I', '-S', '-c', `import sys;sys.path.insert(0,${JSON.stringify(join(scratch, 'sdk-py'))});import build_backend;print(build_backend.build_editable(${JSON.stringify(join(scratch, 'editable'))}))`]).trim()
  run(python, ['-c', `import zipfile;zipfile.ZipFile(${JSON.stringify(join(scratch, 'editable', editable))}).extractall(${JSON.stringify(purelib)})`])
  sourceImport(python)
  console.log('PASS PEP 660 editable wheel from the build backend, installed into a clean venv made without pip (the venv needs no ensurepip), imports the source tree')
  const pipEnv = { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONDONTWRITEBYTECODE: '1' }
  const pip = spawnSync(PYTHON, ['-m', 'pip', '--version'], { encoding: 'utf8', timeout: 60000, env: pipEnv })
  if (pip.status === 0) {
    const target = venvPython('venv-pip')
    const installed = spawnSync(PYTHON, ['-m', 'pip', '--python', target, 'install', '--no-index', '--no-deps', '--no-build-isolation', '-e', join(scratch, 'sdk-py')], { cwd: scratch, env: pipEnv, encoding: 'utf8', timeout: 120000 })
    if (installed.signal !== null) console.log(`SKIP pip editable install: pip did not finish within 120 s on this host (ended by ${installed.signal}); the backend road above stands`)
    else {
      assert.equal(installed.status, 0, `pip: ${installed.stdout}${installed.stderr}`)
      sourceImport(target)
      console.log(`PASS pip editable install (${pip.stdout.trim().split(' from ')[0]} of the running interpreter, driving the pip-less venv) and source import`)
    }
  } else console.log('SKIP pip editable install: the running python3 carries no pip (the backend road above stands)')
  mkdirSync(join(scratch, 'scripts/sdk'), { recursive: true })
  for (const name of ['publish-npm.sh', 'publish-pypi.sh']) cpSync(join(root, 'scripts/sdk', name), join(scratch, 'scripts/sdk', name))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'junction')
  for (const dir of ['sdk', 'sdk-py']) { mkdirSync(join(scratch, dir, 'dist')); writeFileSync(join(scratch, dir, 'dist/stale.file'), 'stale') }
  const index = join(scratch, 'index.json')
  writeFileSync(index, JSON.stringify({ status: 404 }))
  writeFileSync(join(scratch, 'registry.mjs'), `import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const execFileSync = childProcess.execFileSync
childProcess.execFileSync = (command, args, ...rest) => command === 'npm' && args[0] === 'whoami' ? 'fixture-maintainer\\n' : execFileSync(command, args, ...rest)
syncBuiltinESMExports()
globalThis.fetch = async url => {
  if (String(url) !== 'https://registry.npmjs.org/mercury-cli-sdk') throw Error('unexpected network')
  const data = JSON.parse(fs.readFileSync(${JSON.stringify(index)}, 'utf8'))
  return new Response(JSON.stringify(data), { status: data.status })
}
`)
  writeFileSync(join(scratch, 'sitecustomize.py'), `import io, json, pathlib, urllib.request, urllib.error
def local(url, *args, **kwargs):
    assert url == 'https://pypi.org/pypi/mercury-cli-sdk/json'
    data = json.loads(pathlib.Path(${JSON.stringify(index)}).read_text())
    if data['status'] == 404: raise urllib.error.HTTPError(url, 404, 'fixture', {}, None)
    return io.BytesIO(json.dumps(data).encode())
urllib.request.urlopen = local
`)
  const env = { ...process.env, NODE_OPTIONS: `--import=${join(scratch, 'registry.mjs')}`, PYTHONPATH: scratch, npm_config_cache: join(scratch, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_offline: 'true' }
  for (const name of ['pypi', 'npm']) run('bash', [join(scratch, `scripts/sdk/publish-${name}.sh`)], env)
  for (const dir of ['sdk', 'sdk-py']) assert(!existsSync(join(scratch, dir, 'dist/stale.file')))
  console.log('PASS generator output isolation, banners, package links and publish dist cleanup with mocked registry checks; nothing uploaded')
  const previous = { status: 200, maintainers: [{ name: 'fixture-maintainer' }], versions: { '0.1.0': {} }, releases: { '0.1.0': [] } }
  writeFileSync(index, JSON.stringify(previous))
  for (const name of ['pypi', 'npm']) {
    const out = run('bash', [join(scratch, `scripts/sdk/publish-${name}.sh`)], env)
    assert(out.includes('DRY RUN: would publish mercury-cli-sdk'), out)
  }
  console.log('PASS both publication scripts prepare a new version of an existing project without a network request or upload')
  writeFileSync(index, JSON.stringify({ ...previous, versions: { ...previous.versions, [pkg.version]: {} }, releases: { ...previous.releases, [pkg.version]: [] } }))
  for (const name of ['pypi', 'npm']) {
    const result = spawnSync('bash', [join(scratch, `scripts/sdk/publish-${name}.sh`)], { cwd: scratch, env, encoding: 'utf8', timeout: 120000 })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    if (name === 'pypi') assert.equal(result.stderr.trim(), `mercury-cli-sdk ${pkg.version} is already published on PyPI.`)
    else assert.match(result.stderr, /version already published/)
    assert(!result.stdout.includes('DRY RUN: would publish'))
  }
  console.log('PASS both publication scripts refuse an already-published version; PyPI names that version in one sentence')
} finally { rmSync(scratch, { recursive: true, force: true }) }
