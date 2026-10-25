import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const GB = 1e9
const shards = (folder, stem, count, bytesEach) => Array.from({ length: count }, (_, index) => ({ path: folder + '/' + stem + '-' + String(index + 1).padStart(5, '0') + '-of-' + String(count).padStart(5, '0') + '.gguf', size: bytesEach }))
const safetensorShards = (count, bytesEach) => Array.from({ length: count }, (_, index) => ({ path: 'model-' + String(index + 1).padStart(5, '0') + '-of-' + String(count).padStart(5, '0') + '.safetensors', size: bytesEach }))
const small = (...paths) => paths.map(path => ({ path, size: 4096 }))

const HF_FIXTURE_TOKEN = 'fixture-hf-token-not-a-real-token'

export const fixtureRepos = {
  gguf: {
    id: 'unsloth/DeepSeek-V4.1-Flash-GGUF', downloads: 412000, gated: false, private: false, library_name: 'gguf', pipeline_tag: 'text-generation',
    tags: ['gguf', 'text-generation', 'license:mit', 'conversational'], cardData: { license: 'mit', base_model: ['deepseek-ai/DeepSeek-V4.1-Flash-1017'] },
    gguf: { total: 284e9, context_length: 1048576, architecture: 'deepseek41' }, safetensors: null, config: {},
    files: [...small('.gitattributes', 'README.md'), ...shards('Q4_K_M', 'DeepSeek-V4.1-Flash-Q4_K_M', 4, 30 * GB), ...shards('Q8_0', 'DeepSeek-V4.1-Flash-Q8_0', 7, 43 * GB), ...shards('BF16', 'DeepSeek-V4.1-Flash-BF16', 12, 47 * GB)],
    rawConfig: undefined,
  },
  fp8: {
    id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', downloads: 3400000, gated: false, private: false, library_name: 'transformers', pipeline_tag: 'text-generation',
    tags: ['transformers', 'safetensors', 'deepseek_v4', 'text-generation', 'license:mit', 'fp8', 'conversational'], cardData: { license: 'mit' },
    gguf: null, safetensors: { parameters: { F8_E4M3: 280e9, BF16: 4e9, F32: 1e6 }, total: 284.001e9 },
    config: { architectures: ['DeepseekV4ForCausalLM'], model_type: 'deepseek_v4', quantization_config: { quant_method: 'fp8', fmt: 'e4m3' } },
    files: [...small('.gitattributes', 'README.md', 'config.json', 'model.safetensors.index.json', 'tokenizer.json', 'chat_template.jinja'), ...safetensorShards(72, 4 * GB)],
    rawConfig: { architectures: ['DeepseekV4ForCausalLM'], model_type: 'deepseek_v4', max_position_embeddings: 1048576, torch_dtype: 'bfloat16', num_hidden_layers: 43, hidden_size: 4096, quantization_config: { quant_method: 'fp8', fmt: 'e4m3', weight_block_size: [128, 128] } },
  },
  gated: {
    id: 'mercury-bounties/deepseek-coder-v4-bounty', downloads: 1200, gated: 'manual', private: false, library_name: 'transformers', pipeline_tag: 'text-generation',
    tags: ['transformers', 'safetensors', 'text-generation', 'license:mit', 'conversational'], cardData: { license: 'mit' },
    gguf: null, safetensors: { parameters: { BF16: 36e9 }, total: 36e9 },
    config: { architectures: ['DeepseekV4ForCausalLM'], model_type: 'deepseek_v4' },
    files: [...small('.gitattributes', 'README.md', 'config.json', 'model.safetensors.index.json', 'tokenizer.json'), ...safetensorShards(18, 4 * GB)],
    rawConfig: { architectures: ['DeepseekV4ForCausalLM'], model_type: 'deepseek_v4', max_position_embeddings: 131072, torch_dtype: 'bfloat16' },
  },
  vision: {
    id: 'deepseek-ai/DeepSeek-OCR-2', downloads: 640000, gated: false, private: false, library_name: 'transformers', pipeline_tag: 'image-text-to-text',
    tags: ['transformers', 'safetensors', 'image-text-to-text', 'vision', 'license:mit'], cardData: { license: 'mit' },
    gguf: null, safetensors: { parameters: { BF16: 3e9 }, total: 3e9 },
    config: { architectures: ['DeepseekOCRForConditionalGeneration'], model_type: 'deepseek_ocr' },
    files: [...small('.gitattributes', 'README.md', 'config.json', 'preprocessor_config.json'), { path: 'model.safetensors', size: 6 * GB }],
    rawConfig: { architectures: ['DeepseekOCRForConditionalGeneration'], model_type: 'deepseek_ocr', max_position_embeddings: 8192 },
  },
}

export const fixtureExtraRepos = {
  exl3: {
    id: 'dealignai/DeepSeek-V4.1-Flash-1017-EXL3-2.9bpw-UNCENSORED', downloads: 2100, gated: false, private: false, library_name: 'exllamav3', pipeline_tag: 'text-generation',
    tags: ['exllamav3', 'safetensors', 'deepseek_v41', 'exl3', 'deepseek', 'uncensored', 'text-generation', 'license:other'], cardData: { license: 'other' },
    gguf: null, safetensors: { parameters: { BF16: 2631862016, F16: 470703488, I16: 103183843328, F32: 42373458, F8_E4M3: 196928422400 }, total: 303257204690 },
    config: { architectures: ['DeepseekV41ForCausalLM'], model_type: 'deepseek_v41', quantization_config: { quant_method: 'exl3' } },
    files: [...small('.gitattributes', 'LICENSE', 'README.md', 'config.json', 'exl3_k_map.json', 'tokenizer.json'), { path: 'quantization_config.json', size: 54653012 }, ...safetensorShards(43, 2.9 * GB)],
    rawConfig: { architectures: ['DeepseekV41ForCausalLM'], model_type: 'deepseek_v41', max_position_embeddings: 131072, quantization_config: { quant_method: 'exl3', version: '1.6.2', avg_bits: 2.9, head_bits: 6, original_quantization_config: { quant_method: 'fp8', activation_scheme: 'dynamic' } } },
  },
  hqq: {
    id: 'mercury-bounties/DeepSeek-V4.1-Flash-HQQ-4bit', downloads: 300, gated: false, private: false, library_name: 'transformers', pipeline_tag: 'text-generation',
    tags: ['transformers', 'safetensors', 'deepseek_v4', 'text-generation', 'license:mit'], cardData: { license: 'mit' },
    gguf: null, safetensors: { parameters: { U8: 140e9, BF16: 4e9 }, total: 144e9 },
    config: { architectures: ['DeepseekV4ForCausalLM'], model_type: 'deepseek_v4', quantization_config: { quant_method: 'hqq', nbits: 4 } },
    files: [...small('.gitattributes', 'README.md', 'config.json', 'model.safetensors.index.json', 'tokenizer.json'), ...safetensorShards(36, 4 * GB)],
    rawConfig: { architectures: ['DeepseekV4ForCausalLM'], model_type: 'deepseek_v4', max_position_embeddings: 131072, quantization_config: { quant_method: 'hqq', nbits: 4, group_size: 64 } },
  },
}

const listRow = repo => ({ _id: 'fixture-' + repo.id, id: repo.id, downloads: repo.downloads, gated: repo.gated, private: repo.private, library_name: repo.library_name, pipeline_tag: repo.pipeline_tag, tags: repo.tags, cardData: repo.cardData, gguf: repo.gguf, safetensors: repo.safetensors, config: repo.config, siblings: repo.files.map(file => ({ rfilename: file.path })) })

const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes }
const ggufString = text => { const bytes = Buffer.from(text, 'utf8'); return Buffer.concat([u64(bytes.length), bytes]) }
export function ggufHeaderBytes({ architecture, kv = {}, tensors = [], padding = 0 }) {
  const entries = [...(architecture === undefined ? [] : [['general.architecture', architecture]]), ...Object.entries(kv)]
  const parts = [Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(entries.length)]
  for (const [key, value] of entries) {
    parts.push(ggufString(key))
    if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'number')) { parts.push(u32(9), u32(4), u64(value.length)); for (const item of value) parts.push(u32(item)) }
    else if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'boolean')) { parts.push(u32(9), u32(7), u64(value.length)); for (const item of value) parts.push(Buffer.from([item ? 1 : 0])) }
    else if (Array.isArray(value)) { parts.push(u32(9), u32(8), u64(value.length)); for (const item of value) parts.push(ggufString(item)) }
    else if (typeof value === 'number') parts.push(u32(4), u32(value))
    else if (typeof value === 'boolean') parts.push(u32(7), Buffer.from([value ? 1 : 0]))
    else parts.push(u32(8), ggufString(value))
  }
  for (const name of tensors) parts.push(ggufString(name), u32(2), u64(4096), u64(4096), u32(0), u64(0))
  return Buffer.concat([...parts, Buffer.alloc(padding)])
}
const ggufFamilies = ['token_embd', 'output_norm', 'output', 'blk.N.attn_norm', 'blk.N.attn_q_a', 'blk.N.attn_q_a_norm', 'blk.N.attn_q_b', 'blk.N.attn_kv_a_mqa', 'blk.N.attn_kv_a_norm', 'blk.N.attn_k_b', 'blk.N.attn_v_b', 'blk.N.attn_output', 'blk.N.ffn_norm', 'blk.N.ffn_gate_inp', 'blk.N.ffn_gate_exps', 'blk.N.ffn_down_exps', 'blk.N.ffn_up_exps', 'blk.N.ffn_gate_shexp', 'blk.N.ffn_down_shexp', 'blk.N.ffn_up_shexp', 'blk.N.exp_probs_b']
const ggufTensorNames = (first, last, extra = []) => Array.from({ length: last - first + 1 }, (_, i) => first + i).flatMap(block => [...ggufFamilies, ...extra].filter(family => family.startsWith('blk.N.')).map(family => family.replace('blk.N.', 'blk.' + block + '.') + (family.endsWith('exp_probs_b') ? '.bias' : '.weight')))
export function ggufFixtureShards(variant = 'ok') {
  const architecture = variant === 'fork' ? 'glm5next' : 'deepseek2'
  const extra = variant === 'unknown-family' ? ['blk.N.ffn_gate_router_fancy'] : []
  const chatTemplate = 'x'.repeat(700 * 1024)
  const tokens = Array.from({ length: 2000 }, (_, i) => 'tok' + i)
  const first = ggufHeaderBytes({ architecture, kv: { 'general.name': 'fixture', 'deepseek2.block_count': 61, 'split.no': 0, 'split.count': 4, 'split.tensors.count': 3 + 18 * 60, 'tokenizer.ggml.tokens': tokens, 'tokenizer.chat_template': chatTemplate }, tensors: ['token_embd.weight', 'output_norm.weight', 'output.weight'] })
  const rest = [[0, 19], [20, 39], [40, 59]].map(([a, b], i) => ggufHeaderBytes({ kv: { 'split.no': i + 1, 'split.count': 4, 'split.tensors.count': 3 + 18 * 60 }, tensors: ggufTensorNames(a, b, extra) }))
  return [first, ...rest]
}

export async function hfFixture(options = {}) {
  const requests = []
  const state = { searches: 0, trees: 0, configs: 0, delayMs: 0, down: false, lastSearch: null, pageSize: 0, repeatPage: false, rateLimited: false, rateLimitReset: 117, ggufVariant: 'ok', ranges: [], resolveBytes: 0 }
  const repos = [...Object.values(fixtureRepos), ...(options.extra ?? [])]
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({ method: req.method, path: url.pathname, search: url.search, authorization: req.headers.authorization ?? null, range: req.headers.range ?? null })
    if (state.down) { req.socket.destroy(); return }
    if (state.rateLimited) { res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', RateLimit: '"api";r=0;t=' + state.rateLimitReset, 'RateLimit-Policy': '"fixed window";"api";q=500;w=300' }); res.end(JSON.stringify({ error: 'Too Many Requests' })); return }
    const pause = () => state.delayMs ? new Promise(resolve => setTimeout(resolve, state.delayMs)) : Promise.resolve()
    const send = (value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value)) }
    const authorised = req.headers.authorization === 'Bearer ' + HF_FIXTURE_TOKEN
    if (url.pathname === '/api/models') {
      state.searches++
      const query = url.searchParams.get('search') ?? ''
      state.lastSearch = { query, params: url.search }
      assert.equal(url.searchParams.get('pipeline_tag'), 'text-generation')
      assert.equal(url.searchParams.get('sort'), 'downloads')
      assert.ok(Number(url.searchParams.get('limit')) > 0 && Number(url.searchParams.get('limit')) <= 100)
      const expand = url.searchParams.getAll('expand')
      for (const key of ['downloads', 'gated', 'siblings', 'safetensors', 'cardData', 'config', 'tags', 'pipeline_tag']) assert.ok(expand.includes(key), 'search expands ' + key)
      const rows = repos.filter(repo => repo.id.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.downloads - a.downloads).map(listRow)
      await pause()
      return send(rows)
    }
    const info = /^\/api\/models\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (info) {
      const repo = repos.find(row => row.id === decodeURIComponent(info[1]) + '/' + decodeURIComponent(info[2]))
      if (!repo) return send({ error: 'Repository not found' }, 404)
      if (repo.gated && !authorised) return send({ error: 'Access restricted' }, 401)
      await pause()
      return send({ id: repo.id, sha: createHash('sha1').update(repo.id).digest('hex') })
    }
    const tree = /^\/api\/models\/([^/]+)\/([^/]+)\/tree\/(main|[a-f0-9]{40})$/.exec(url.pathname)
    if (tree) {
      state.trees++
      const repo = repos.find(row => row.id === decodeURIComponent(tree[1]) + '/' + decodeURIComponent(tree[2]))
      if (!repo) return send({ error: 'Repository not found' }, 404)
      if (repo.gated && !authorised) return send({ error: 'Access to model ' + repo.id + ' is restricted. You must have access to it and be authenticated to access it. Please log in.' }, 401)
      assert.equal(url.searchParams.get('recursive'), 'true')
      await pause()
      const entries = [...new Set(repo.files.filter(file => file.path.includes('/')).map(file => file.path.slice(0, file.path.indexOf('/'))))].map(path => ({ type: 'directory', oid: 'd' + path, size: 0, path }))
      const rows = [...entries, ...repo.files.map(file => ({ type: 'file', oid: file.git ?? createHash('sha1').update(file.path).digest('hex'), size: file.size, ...(file.sha256 || file.size > 1e6 ? { lfs: { oid: file.sha256 ?? createHash('sha256').update(file.path).digest('hex'), size: file.size, pointerSize: 134 } } : {}), path: file.path }))]
      const offset = Number(url.searchParams.get('cursor') ?? 0)
      const size = state.pageSize || rows.length
      const next = new URL(req.url, 'http://' + req.headers.host)
      if (!state.repeatPage) next.searchParams.set('cursor', String(offset + size))
      return send(rows.slice(offset, offset + size), 200, offset + size < rows.length || state.repeatPage ? { Link: '<' + next + '>; rel="next"' } : {})
    }
    const raw = /^\/([^/]+)\/([^/]+)\/raw\/(main|[a-f0-9]{40})\/config\.json$/.exec(url.pathname)
    if (raw) {
      state.configs++
      const repo = repos.find(row => row.id === decodeURIComponent(raw[1]) + '/' + decodeURIComponent(raw[2]))
      if (!repo || !repo.rawConfig) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Entry not found'); return }
      if (repo.gated && !authorised) return send({ error: 'Access to model ' + repo.id + ' is restricted.' }, 401)
      await pause()
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(JSON.stringify(repo.rawConfig, null, 2)); return
    }
    const resolved = /^\/([^/]+)\/([^/]+)\/resolve\/(main|[a-f0-9]{40})\/(.+)$/.exec(url.pathname)
    if (resolved) {
      const repo = repos.find(row => row.id === decodeURIComponent(resolved[1]) + '/' + decodeURIComponent(resolved[2]))
      const path = resolved[4].split('/').map(decodeURIComponent).join('/')
      const file = repo?.files.find(row => row.path === path)
      if (!repo || !file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Entry not found'); return }
      if ((repo.gated && !authorised) || state.ggufVariant === 'gated') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Access to this file is restricted'); return }
      if (state.ggufVariant === 'redirect' && !url.searchParams.has('cdn')) { res.writeHead(302, { Location: url.pathname + '?cdn=1' }); res.end(); return }
      const shard = /-(\d{5})-of-\d{5}\.gguf$/.exec(path)
      const content = state.ggufVariant === 'not-gguf' ? Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + 'ab'.repeat(32) + '\nsize ' + file.size + '\n') : ggufFixtureShards(state.ggufVariant)[shard ? Number(shard[1]) - 1 : 0]
      const total = Math.max(file.size, content.length)
      const range = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? '')
      if (!range || state.ggufVariant === 'no-range') { state.resolveBytes += content.length; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(content.length) }); res.end(content); return }
      const start = Number(range[1])
      const end = Math.min(range[2] === undefined ? total - 1 : Number(range[2]), total - 1)
      state.ranges.push({ path, start, end })
      const body = Buffer.alloc(end - start + 1)
      content.copy(body, 0, start, Math.min(content.length, end + 1))
      state.resolveBytes += body.length
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes ' + start + '-' + end + '/' + total, 'Content-Length': String(body.length) }); res.end(body); return
    }
    send({ error: 'fixture: no such route ' + url.pathname }, 404)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: 'http://127.0.0.1:' + server.address().port, token: HF_FIXTURE_TOKEN, state, requests, repos: fixtureRepos, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
