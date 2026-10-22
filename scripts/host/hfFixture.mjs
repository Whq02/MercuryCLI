import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const GB = 1e9
const shards = (folder, stem, count, bytesEach) => Array.from({ length: count }, (_, index) => ({ path: folder + '/' + stem + '-' + String(index + 1).padStart(5, '0') + '-of-' + String(count).padStart(5, '0') + '.gguf', size: bytesEach }))
const safetensorShards = (count, bytesEach) => Array.from({ length: count }, (_, index) => ({ path: 'model-' + String(index + 1).padStart(5, '0') + '-of-' + String(count).padStart(5, '0') + '.safetensors', size: bytesEach }))
const small = (...paths) => paths.map(path => ({ path, size: 4096 }))

export const HF_FIXTURE_TOKEN = 'fixture-hf-token-not-a-real-token'

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

const listRow = repo => ({ _id: 'fixture-' + repo.id, id: repo.id, downloads: repo.downloads, gated: repo.gated, private: repo.private, library_name: repo.library_name, pipeline_tag: repo.pipeline_tag, tags: repo.tags, cardData: repo.cardData, gguf: repo.gguf, safetensors: repo.safetensors, config: repo.config, siblings: repo.files.map(file => ({ rfilename: file.path })) })

export async function hfFixture() {
  const requests = []
  const state = { searches: 0, trees: 0, configs: 0, delayMs: 0, down: false, lastSearch: null }
  const repos = Object.values(fixtureRepos)
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({ method: req.method, path: url.pathname, search: url.search, authorization: req.headers.authorization ?? null })
    if (state.down) { req.socket.destroy(); return }
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
    const tree = /^\/api\/models\/([^/]+)\/([^/]+)\/tree\/main$/.exec(url.pathname)
    if (tree) {
      state.trees++
      const repo = repos.find(row => row.id === decodeURIComponent(tree[1]) + '/' + decodeURIComponent(tree[2]))
      if (!repo) return send({ error: 'Repository not found' }, 404)
      if (repo.gated && !authorised) return send({ error: 'Access to model ' + repo.id + ' is restricted. You must have access to it and be authenticated to access it. Please log in.' }, 401)
      assert.equal(url.searchParams.get('recursive'), 'true')
      await pause()
      const entries = [...new Set(repo.files.filter(file => file.path.includes('/')).map(file => file.path.slice(0, file.path.indexOf('/'))))].map(path => ({ type: 'directory', oid: 'd' + path, size: 0, path }))
      return send([...entries, ...repo.files.map(file => ({ type: 'file', oid: 'f' + file.path, size: file.size, ...(file.size > 1e6 ? { lfs: { oid: 'l' + file.path, size: file.size, pointerSize: 134 } } : {}), path: file.path }))])
    }
    const raw = /^\/([^/]+)\/([^/]+)\/raw\/main\/config\.json$/.exec(url.pathname)
    if (raw) {
      state.configs++
      const repo = repos.find(row => row.id === decodeURIComponent(raw[1]) + '/' + decodeURIComponent(raw[2]))
      if (!repo || !repo.rawConfig) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Entry not found'); return }
      if (repo.gated && !authorised) return send({ error: 'Access to model ' + repo.id + ' is restricted.' }, 401)
      await pause()
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(JSON.stringify(repo.rawConfig, null, 2)); return
    }
    send({ error: 'fixture: no such route ' + url.pathname }, 404)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: 'http://127.0.0.1:' + server.address().port, token: HF_FIXTURE_TOKEN, state, requests, repos: fixtureRepos, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
