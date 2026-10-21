import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-package-review-')))
function run(command: string, args: string[], env = process.env, cwd = scratch) {
  const result = spawnSync(command, args, { cwd, env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 120000 })
  assert.equal(result.status, 0, `${command}: ${result.stdout}${result.stderr}`)
  return result.stdout
}
try {
  const before = readFileSync(join(root, 'sdk-py/src/mercury_cli_sdk/generated.py'), 'utf8')
  run('bun', [join(root, 'scripts/sdk/generate.ts'), '--out', join(scratch, 'generated')])
  assert.equal(readFileSync(join(root, 'sdk-py/src/mercury_cli_sdk/generated.py'), 'utf8'), before)
  assert(readFileSync(join(scratch, 'generated/wire.ts'), 'utf8').includes('WIRE_GENERATED_FROM'))
  assert(readFileSync(join(scratch, 'generated/python/generated.py'), 'utf8').includes('GENERATED_BY ='))
  for (const dir of ['sdk', 'sdk-py']) cpSync(join(root, dir), join(scratch, dir), { recursive: true, filter: p => !/(\/dist|\/node_modules|\/__pycache__)(\/|$)/.test(p) })
  const pkg = JSON.parse(readFileSync(join(scratch, 'sdk/package.json'), 'utf8'))
  assert.equal(pkg.homepage, 'https://mercury-cli.ai'); assert.equal(pkg.repository.directory, 'sdk')
  const venvPython = (name: string) => { run('python3', ['-m', 'venv', '--without-pip', join(scratch, name)]); return join(scratch, name, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') }
  const sourceImport = (python: string) => run(python, ['-c', `import mercury_cli_sdk as s;from pathlib import Path;assert Path(s.__file__).resolve()==Path(${JSON.stringify(join(scratch, 'sdk-py/src/mercury_cli_sdk/__init__.py'))}),s.__file__`])
  const python = venvPython('venv')
  const purelib = run(python, ['-c', 'import sysconfig;print(sysconfig.get_paths()["purelib"])']).trim()
  const editable = run('python3', ['-I', '-S', '-c', `import sys;sys.path.insert(0,${JSON.stringify(join(scratch, 'sdk-py'))});import build_backend;print(build_backend.build_editable(${JSON.stringify(join(scratch, 'editable'))}))`]).trim()
  run(python, ['-c', `import zipfile;zipfile.ZipFile(${JSON.stringify(join(scratch, 'editable', editable))}).extractall(${JSON.stringify(purelib)})`])
  sourceImport(python)
  console.log('PASS PEP 660 editable wheel from the build backend, installed into a clean venv made without pip (the venv needs no ensurepip), imports the source tree')
  const pip = spawnSync('python3', ['-m', 'pip', '--version'], { encoding: 'utf8', timeout: 60000 })
  if (pip.status === 0) {
    const target = venvPython('venv-pip')
    run('python3', ['-m', 'pip', '--python', target, 'install', '--no-index', '--no-deps', '--no-build-isolation', '-e', join(scratch, 'sdk-py')])
    sourceImport(target)
    console.log(`PASS pip editable install (${pip.stdout.trim().split(' from ')[0]} of the running interpreter, driving the pip-less venv) and source import`)
  } else console.log('SKIP pip editable install: the running python3 carries no pip (the backend road above stands)')
  mkdirSync(join(scratch, 'scripts/sdk'), { recursive: true })
  for (const name of ['publish-npm.sh', 'publish-pypi.sh']) cpSync(join(root, 'scripts/sdk', name), join(scratch, 'scripts/sdk', name))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'))
  for (const dir of ['sdk', 'sdk-py']) { mkdirSync(join(scratch, dir, 'dist')); writeFileSync(join(scratch, dir, 'dist/stale.file'), 'stale') }
  writeFileSync(join(scratch, 'registry.mjs'), `globalThis.fetch=async url=>{if(!String(url).startsWith('https://registry.npmjs.org/'))throw Error('unexpected network');return new Response('',{status:404})}`)
  writeFileSync(join(scratch, 'sitecustomize.py'), `import urllib.request,urllib.error\ndef local(url,*args,**kwargs):\n assert url=='https://pypi.org/pypi/mercury-cli-sdk/json'\n raise urllib.error.HTTPError(url,404,'fixture',{},None)\nurllib.request.urlopen=local\n`)
  const env = { ...process.env, NODE_OPTIONS: `--import=${join(scratch, 'registry.mjs')}`, PYTHONPATH: scratch, npm_config_cache: join(scratch, 'npm-cache'), npm_config_update_notifier: 'false' }
  run('bash', [join(scratch, 'scripts/sdk/publish-npm.sh')], env)
  run('bash', [join(scratch, 'scripts/sdk/publish-pypi.sh')], env)
  for (const dir of ['sdk', 'sdk-py']) assert(!existsSync(join(scratch, dir, 'dist/stale.file')))
  console.log('PASS generator output isolation, banners, package links and publish dist cleanup with mocked registry checks; nothing uploaded')
} finally { rmSync(scratch, { recursive: true, force: true }) }
