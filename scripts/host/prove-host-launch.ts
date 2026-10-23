import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pinSourceRef, waitFor } from '../lib/settingsPopupHarness.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
pinSourceRef()
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'launch-'))
const bin = join(scratch, 'bin'); mkdirSync(bin)
const writeCommand = (name: string, source: string) => writeFileSync(join(bin, name), source, { mode: 0o700 })
writeCommand('setsid', '#!/usr/bin/env python3\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n')
writeCommand('tmux', '#!/usr/bin/env python3\nimport subprocess,sys\nif sys.argv[1] == "has-session": sys.exit(1)\nsubprocess.Popen(["bash","-c",sys.argv[-1]],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n')
writeCommand('hf', '#!/bin/bash\necho fixture-downloaded\n')
writeCommand('sglang', '#!/usr/bin/env python3\nimport os,time\nopen(os.environ["FIXTURE_ENGINE_PID"],"w").write(str(os.getpid()))\nprint("fixture-engine-ready",flush=True)\ntime.sleep(120)\n')
const { startHostEngine } = await import('../../src/services/host/ssh.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const env = { ...process.env, PATH: bin + ':' + process.env.PATH, FIXTURE_ENGINE_PID: join(scratch, 'engine.pid') }
const remoteDir = join(scratch, 'workspace/fixture-launch')
const commands: string[] = []
const runner = {
  async run(command: string, args: string[]): Promise<string> {
    assert.equal(command, 'ssh')
    const remote = args.at(-1)!.replaceAll('/workspace/mercury-host', join(scratch, 'workspace'))
    commands.push(remote)
    return await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', remote], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)))
    })
  },
  tunnel(): never { throw new Error('No tunnel in the launch proof') },
}
const recipe = { ...HOST_RECIPES[2]!, id: 'fixture-launch', model: 'Fixture/Launch', flags: [], environment: {}, files: {}, install: 'echo fixture-install-failed; false' }
try {
  let failed = ''
  try { await startHostEngine({ host: '127.0.0.1' }, recipe, runner, new AbortController().signal, false, true) } catch (error) { failed = String(error) }
  assert.ok(failed.includes('fixture-install-failed'), 'a real shell failure before engine exec must surface, not a tmux launch success')
  assert.ok(readFileSync(join(remoteDir, 'engine.log'), 'utf8').includes('fixture-install-failed'), 'redirection owns the whole setup script')
  assert.ok(existsSync(join(remoteDir, 'launch.log')), 'launcher stderr is redirected before anything else')
  console.log('PASS install failure is fatal, logged and returned by the real launch shell')
  const started = Date.now()
  await startHostEngine({ host: '127.0.0.1' }, { ...recipe, install: 'echo fixture-install-ok' }, runner, new AbortController().signal, false, true)
  assert.ok(Date.now() - started >= 4900, 'launch verifies liveness five seconds later')
  const pid = Number(readFileSync(env.FIXTURE_ENGINE_PID, 'utf8')); process.kill(pid, 0)
  assert.ok(readFileSync(join(remoteDir, 'engine.log'), 'utf8').includes('fixture-engine-ready'))
  assert.ok(commands.some(command => command.includes('pgrep -f') && command.includes('nohup setsid bash')))
  console.log('PASS script survives its SSH shell and passes the delayed process check')
  await startHostEngine({ host: '127.0.0.1' }, { ...recipe, install: 'echo must-not-run' }, runner, new AbortController().signal, false, true)
  assert.equal(Number(readFileSync(env.FIXTURE_ENGINE_PID, 'utf8')), pid, 'resume adopts the existing engine, never starts a second one')
  assert.ok(readFileSync(join(remoteDir, 'engine.sh'), 'utf8').includes('export PATH=/usr/local/cuda/bin:$PATH CUDACXX=/usr/local/cuda/bin/nvcc'))
  for (const [id, cap, expected] of [['glm53-flash-gguf-b300', '10.3', '103'], ['nemotron35-super-gguf-rtx-pro-6000', '12.0', '120']] as const) {
    const gguf = HOST_RECIPES.find(row => row.id === id)!
    assert.ok(gguf.install?.includes('PATH=/usr/local/cuda/bin:$PATH CUDACXX=/usr/local/cuda/bin/nvcc') && gguf.install.includes('-DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc') && gguf.install.includes('184f6536024668e8908ab8c86033d56708e62b40'))
    assert.ok(gguf.flags.join(' ').includes('--ctx-size 524288 --parallel 4 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0'))
    writeCommand('nvidia-smi', `#!/bin/bash\necho "${cap}"\n`)
    const arch = await runner.run('ssh', ['127.0.0.1', 'printf %s "$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d .)"'])
    assert.equal(arch.trim(), expected)
  }
  console.log('PASS CUDA compiler path, compute_cap architecture stripping (103/120), upstream llama.cpp pin and 4-slot 524k context')
  console.log('HOST LAUNCH GREEN — real shell execution with local executables; no network or GPU')
} finally {
  if (existsSync(env.FIXTURE_ENGINE_PID)) { const pid = Number(readFileSync(env.FIXTURE_ENGINE_PID, 'utf8')); try { process.kill(pid, 'SIGTERM') } catch {} }
  if (existsSync(join(remoteDir, 'engine.pid'))) { const pid = Number(readFileSync(join(remoteDir, 'engine.pid'), 'utf8')); await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } }, 3000) }
  rmSync(scratch, { recursive: true, force: true })
}
