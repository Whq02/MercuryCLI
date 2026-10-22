import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { fakeSshRunner } from './runpodFixture.mjs'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
f.state.dialect = 'llamacpp'
f.state.window = 131072
f.state.slots = 4
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
try {
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const { hostRunner, startHostEngine, restartHostScript, readHostEngine } = await import('../../src/services/host/ssh.ts')
  const recipe = HOST_RECIPES.find(row => row.id === 'glm53-flash-gguf-b300')!
  const signal = new AbortController().signal
  const target = { host: '127.0.0.1', port: 2222, user: 'root' }
  for (const prebuilt of [true, false]) {
    const ssh = fakeSshRunner(f.baseUrl, hostRunner, f.state)
    const runner = { ...ssh.runner, async run(command: string, args: string[], abort: AbortSignal, timeout?: number) {
      if (args.at(-1)?.includes('command -v llama-server')) return prebuilt ? 'MERCURY_PREBUILT_ENGINE yes\n' : ''
      return ssh.runner.run(command, args, abort, timeout)
    } }
    try {
      await startHostEngine(target, recipe, runner, signal, false, true)
      const original = ssh.state.script
      const label = prebuilt ? 'prebuilt' : 'source-built'
      check(label + ' launch uses its real executable spelling', prebuilt ? original.includes("'llama-server' '--model'") : original.includes("'/workspace/mercury-host/llama.cpp/build/bin/llama-server' '--model'"))
      if (prebuilt) {
        const scriptPath = ssh.state.engine.spawnargs.at(-1)!
        writeFileSync(scriptPath, original.replace("'llama-server' '--model'", "'llama-server-copy' '--model'"))
        await assert.rejects(restartHostScript(target, recipe, runner, signal, { restore: false, token: 'lookalike-fixture' }), /no llama-server command/)
        check('a lookalike executable cannot pass the process-identity guard or restart anything', ssh.state.restarts === 1 && !ssh.state.retuned)
        writeFileSync(scriptPath, original)
      }
      const flags = [...recipe.flags]
      flags[flags.indexOf('--parallel') + 1] = '2'
      flags[flags.indexOf('--ctx-size') + 1] = '2097152'
      const tuned = { ...recipe, flags }
      await restartHostScript(target, tuned, runner, signal, { restore: false, token: label + '-fixture' })
      check(label + ' Tune rewrites and restarts the saved launch instead of refusing its executable', ssh.state.retuned && ssh.state.restarts === 2 && ssh.state.script.includes('--parallel 2') && ssh.state.script.includes('--ctx-size 2097152'))
      check(label + ' Tune preserves the selected executable and avoids reinstallation or download', ssh.state.script.includes(prebuilt ? '\nllama-server --model' : '/workspace/mercury-host/llama.cpp/build/bin/llama-server --model') && !/hf download|cmake|apt-get/.test(ssh.state.script))
      const after = await readHostEngine(target, tuned, runner, signal)
      check(label + ' engine is alive and reports the retuned per-conversation context', after.alive && after.conversations === 2 && after.contextPerConversation === 1048576)
      await restartHostScript(target, recipe, runner, signal, { restore: true, token: label + '-fixture' })
      const restored = await readHostEngine(target, recipe, runner, signal)
      check(label + ' rollback restores the prior conversations and context', ssh.state.restored && ssh.state.restarts === 3 && restored.alive && restored.conversations === 4 && restored.contextPerConversation === 131072)
    } finally { ssh.close() }
  }
  console.log('PREBUILT HOST TUNE GREEN — ' + checks + ' checks; real Python rewrite and owned fixture processes; no SSH or rental')
} finally { f.close() }
