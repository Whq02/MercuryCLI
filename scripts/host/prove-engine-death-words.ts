import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
pinSourceRef()
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'engine-death-'))
const { waitHostEngine, engineDeathWords } = await import('../../src/services/host/ssh.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')

const glm = HOST_RECIPES.find(row => row.id === 'glm53-flash-gguf-b300')!
const recipe = { ...glm, id: 'fixture-death', model: 'Cypherfox/GLM-5.3-Flash-dealignai-orcarouter-merge', weightFile: 'glm5.3-Flash-combined-iq4_xs.gguf' }
const nextnLayer = ['nextn.eh_proj.weight', 'attn_k_b.weight', 'attn_kv_a_mqa.weight', 'attn_kv_a_norm.weight', 'attn_norm.weight', 'attn_output.weight', 'attn_q_a.weight', 'attn_q_a_norm.weight', 'attn_q_b.weight', 'attn_v_b.weight', 'exp_probs_b.bias', 'ffn_down_exps.weight', 'ffn_down_shexp.weight', 'ffn_gate_exps.weight', 'ffn_gate_inp.weight', 'ffn_gate_shexp.weight', 'ffn_norm.weight', 'ffn_up_exps.weight', 'ffn_up_shexp.weight', 'indexer.attn_k.weight', 'indexer.attn_q_b.weight', 'indexer.k_norm.bias', 'indexer.k_norm.weight', 'indexer.proj.weight', 'indexer_compressor_ape.weight', 'indexer_compressor_gate.weight', 'nextn.enorm.weight', 'nextn.hnorm.weight', 'nextn.shared_head_norm.weight']
const unusedLines = nextnLayer.map(name => 'model has unused tensor blk.45.' + name + ' (size = 67108864 bytes) -- ignoring')
const frames = ['llama-server(+0x3f7e6b)[0x5adee1025e6b]', 'llama-server(+0x3f8c70)[0x5adee1026c70]', '/lib/x86_64-linux-gnu/libc.so.6(+0x45330)[0x7a8b1c245330]', '/lib/x86_64-linux-gnu/libc.so.6(pthread_kill+0x11c)[0x7a8b1c29eb2c]', '/lib/x86_64-linux-gnu/libc.so.6(gsignal+0x1e)[0x7a8b1c24527e]', '/lib/x86_64-linux-gnu/libc.so.6(abort+0xdf)[0x7a8b1c2288ff]', 'llama-server(_ZN11llama_model12load_tensorsER18llama_model_loader+0x2b4a)[0x5adee0f1c8aa]', 'llama-server(main+0x1d2)[0x5adee0e0a4f2]', '/lib/x86_64-linux-gnu/libc.so.6(+0x2a1ca)[0x7a8b1c22a1ca]', '[0x5adee0e0c2e5]']
const loading = ['MERCURY_STEP starting engine', 'llama_model_loader: loaded meta data with 76 key-value pairs and 1412 tensors from /workspace/mercury-host/fixture-death/weights/glm5.3-Flash-combined-iq4_xs.gguf (version GGUF V3 (latest))', 'print_info: arch             = glm5-next', 'print_info: n_layer          = 45', 'print_info: file size        = 159.18 GiB (4.26 BPW)', 'load_tensors: loading model tensors, this can take a while... (mmap = true)']
const ownerRun = [...loading, ...unusedLines, ...frames, 'Aborted (core dumped)']

const remoteDir = join(scratch, 'workspace', recipe.id)
mkdirSync(remoteDir, { recursive: true })
writeFileSync(join(remoteDir, 'engine.pid'), '2147483646\n')
writeFileSync(join(remoteDir, 'launch.log'), '')
const commands: string[] = []
const runner = {
  async run(command: string, args: string[]): Promise<string> {
    assert.equal(command, 'ssh')
    const remote = args.at(-1)!.replaceAll('/workspace/mercury-host', join(scratch, 'workspace'))
    commands.push(remote)
    if (remote.includes('/health')) throw new Error('fixture engine never answered')
    return await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', remote], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)))
    })
  },
  tunnel(): never { throw new Error('No tunnel in the engine death proof') },
}
const death = async (log: string[]): Promise<{ words: string; polled: string }> => {
  writeFileSync(join(remoteDir, 'engine.log'), log.join('\n') + '\n')
  const seen: string[] = []
  const before = commands.length
  let words = ''
  try { await waitHostEngine({ host: '127.0.0.1' }, recipe, runner, new AbortController().signal, 10, 4000, text => seen.push(text)) } catch (error) { words = error instanceof Error ? error.message : String(error) }
  assert.ok(words, 'a dead engine ends the wait with a notice')
  assert.ok(commands.slice(before).every(command => command.startsWith('tail -n 8 ')), 'the poll keeps its tail -n 8 front, which the fixtures and the drives key on')
  return { words, polled: seen.join('\n') }
}
const noFrames = (words: string): boolean => !/\(\+0x[0-9a-f]+\)|\[0x[0-9a-f]+\]|_ZN11llama_model/.test(words)
try {
  const owner = await death(ownerRun)
  assert.ok(owner.words.startsWith('the engine died loading the weights: Aborted (core dumped)'), 'with no error line in the log the notice opens on the engine’s last plain line: ' + owner.words)
  assert.ok(owner.words.includes('the engine set aside 29 tensors it does not use (e.g. blk.45.nextn.eh_proj.weight)'), 'the unused-tensor count and an example reach the notice: ' + owner.words)
  assert.ok(noFrames(owner.words), 'no stack-trace frame reaches the notice: ' + owner.words)
  assert.ok(!owner.words.includes('newer llama.cpp'), 'tensors the engine set aside are not called unknown; nothing in this log says the engine needs a newer llama.cpp: ' + owner.words)
  assert.ok(owner.polled.includes('MERCURY_UNUSED_TENSORS 29 blk.45.nextn.eh_proj.weight'), 'the poll reads the count from the whole log, not from the tail')
  console.log('PASS the owner’s run: the notice names Aborted (core dumped) and the 29 set-aside tensors, never a frame')

  const assertion = await death([...loading, ...unusedLines, '/opt/llama.cpp/ggml/src/ggml.c:3407: GGML_ASSERT(ggml_can_repeat(b, a)) failed', ...frames, 'Aborted (core dumped)'])
  assert.ok(assertion.words.startsWith('the engine died loading the weights: /opt/llama.cpp/ggml/src/ggml.c:3407: GGML_ASSERT(ggml_can_repeat(b, a)) failed'), 'the engine’s own assert line leads: ' + assertion.words)
  assert.ok(assertion.words.includes('set aside 29 tensors') && noFrames(assertion.words), assertion.words)
  console.log('PASS a GGML_ASSERT line scrolled past the tail still leads the notice')

  const unknown = await death([...loading.slice(0, 2), "terminate called after throwing an instance of 'std::runtime_error'", "  what():  unknown model architecture: 'glm5next'", ...frames, 'Aborted (core dumped)'])
  assert.ok(unknown.words.startsWith("the engine died loading the weights: terminate called after throwing an instance of 'std::runtime_error' · unknown model architecture: 'glm5next'"), unknown.words)
  assert.ok(unknown.words.includes('the engine does not know this file’s layout; it needs a newer llama.cpp than the engine image carries') && noFrames(unknown.words), unknown.words)
  assert.ok(!unknown.words.includes('set aside'), 'no unused-tensor sentence when none was reported: ' + unknown.words)
  console.log('PASS an unknown architecture names the layout and the newer llama.cpp it needs')

  const oom = await death([...loading, 'CUDA error: out of memory', '  current device: 1, in function ggml_cuda_pool_leg::alloc at /opt/llama.cpp/ggml/src/ggml-cuda/ggml-cuda.cu:542', '  cudaMalloc((void **) &ptr, look_ahead_size)', '/opt/llama.cpp/ggml/src/ggml-cuda/ggml-cuda.cu:95: CUDA error', ...frames, 'Aborted (core dumped)'])
  assert.ok(oom.words.startsWith('the engine died loading the weights: CUDA error: out of memory') && oom.words.includes('the shape was too small for this quality; choose a larger GPU shape') && noFrames(oom.words), oom.words)
  console.log('PASS a CUDA out-of-memory death keeps the engine line and the shape sentence')

  const unit = engineDeathWords(['MERCURY_STEP starting engine', 'common_init_from_params: failed to load model /workspace/mercury-host/x/weights/model.gguf', 'srv  load_model: failed to load model, /workspace/mercury-host/x/weights/model.gguf', 'MERCURY_ENGINE_EXITED'].join('\n'), { engine: 'llamacpp' })
  assert.equal(unit, 'the engine died loading the weights: common_init_from_params: failed to load model /workspace/mercury-host/x/weights/model.gguf')
  const plain = engineDeathWords(['MERCURY_STEP starting engine', 'engine exited with status 137', 'MERCURY_ENGINE_EXITED'].join('\n'), { engine: 'vllm' })
  assert.equal(plain, 'the engine died loading the weights: engine exited with status 137')
  console.log('PASS the words from a captured text alone: first error line, else the plain tail')
  console.log('ENGINE DEATH WORDS GREEN — the poll command ran in a real shell against a fixture of the owner’s log; no network, no GPU')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
