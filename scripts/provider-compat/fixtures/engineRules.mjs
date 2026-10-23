import { createServer } from 'node:http'

export const ENGINE_RULE_SOURCES = {
  llamacpp: {
    checked: '2026-10-22',
    schema: 'https://github.com/ggml-org/llama.cpp/blob/master/common/json-schema.cpp',
    grammar: 'https://github.com/ggml-org/llama.cpp/blob/master/common/json-schema-to-grammar.cpp',
    request: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-common.cpp',
    discovery: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
    capabilities: 'https://github.com/ggml-org/llama.cpp/blob/master/common/jinja/caps.h',
  },
  vllm: {
    checked: '2026-10-22',
    request: 'https://github.com/vllm-project/vllm/blob/main/vllm/entrypoints/openai/chat_completion/protocol.py',
    envelope: 'https://github.com/vllm-project/vllm/blob/main/vllm/entrypoints/serve/engine/protocol.py',
    tools: 'https://docs.vllm.ai/en/latest/features/tool_calling/',
  },
  sglang: {
    checked: '2026-10-23',
    request: 'https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/openai/serving_chat.py',
    envelope: 'https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/openai/protocol.py',
    discovery: 'https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/http_server.py',
    thinking: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/main/encoding/README.md',
  },
  ollama: {
    checked: '2026-10-22',
    request: 'https://github.com/ollama/ollama/blob/main/openai/openai.go',
    discovery: 'https://github.com/ollama/ollama/blob/main/api/types.go',
    capabilities: 'https://github.com/ollama/ollama/blob/main/types/model/capability.go',
    fields: 'https://docs.ollama.com/api/openai-compatibility',
  },
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const schemaMaps = ['properties']
const schemaSingles = ['items', 'additionalProperties']
const schemaLists = ['allOf']

function schemaFailure(schema, root = schema, seen = new Set()) {
  if (!object(schema) || seen.has(schema)) return undefined
  seen.add(schema)
  if ('$ref' in schema) {
    const ref = schema.$ref
    if (typeof ref !== 'string') return '$ref must be a string'
    if (!ref.startsWith('#/')) return `unsupported $ref ${ref}, only references into the same document are supported`
    let target = root
    for (const word of ref.slice(2).split('/').map(word => word.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (!object(target) && !Array.isArray(target) || !Object.hasOwn(target, word)) return `cannot resolve $ref ${ref}, ${word} not found`
      target = target[word]
    }
    return schemaFailure(target, root, seen)
  }
  const alternatives = schema.oneOf ?? schema.anyOf
  if (Array.isArray(alternatives)) {
    for (const child of alternatives) {
      const fault = schemaFailure(child, root, seen)
      if (fault) return fault
    }
    return undefined
  }
  for (const key of schemaMaps) if (object(schema[key])) for (const child of Object.values(schema[key])) {
    const fault = schemaFailure(child, root, seen)
    if (fault) return fault
  }
  for (const key of schemaSingles) {
    const fault = schemaFailure(schema[key], root, seen)
    if (fault) return fault
  }
  for (const key of schemaLists) if (Array.isArray(schema[key])) for (const child of schema[key]) {
    const fault = schemaFailure(child, root, seen)
    if (fault) return fault
  }
  return undefined
}

export function deepseekV4ThinkingMode(body) {
  const kwargs = object(body.chat_template_kwargs) ? body.chat_template_kwargs : {}
  if (typeof kwargs.thinking === 'boolean') return kwargs.thinking ? 'thinking' : 'chat'
  return body.reasoning_effort != null && body.reasoning_effort !== 'none' ? 'thinking' : 'chat'
}

export function engineError(dialect, message, param = null) {
  const type = dialect === 'llamacpp' || dialect === 'ollama' ? 'invalid_request_error' : 'BadRequestError'
  const error = { message, type, ...(dialect === 'ollama' ? { param: null, code: null } : dialect === 'llamacpp' ? { code: 400 } : { param, code: 400 }) }
  return { status: 400, body: dialect === 'sglang' ? { object: 'error', ...error } : { error } }
}

export function validateEngineRequest(dialect, body, config = {}) {
  const refuse = (message, param) => engineError(dialect, message, param)
  if (dialect === 'llamacpp') {
    for (const tool of body.tools ?? []) {
      const fault = schemaFailure(tool.function?.parameters)
      if (fault) return refuse(fault, `tools.${tool.function?.name}.parameters`)
    }
  }
  if (dialect === 'vllm') {
    if (body.tool_choice && body.tool_choice !== 'none' && body.tools == null) return refuse('When using `tool_choice`, `tools` must be set.', 'tool_choice')
    if (object(body.tool_choice) && !body.tools?.some(tool => tool.function?.name === body.tool_choice.function?.name)) return refuse('The tool specified in `tool_choice` does not match any of the specified `tools`', 'tool_choice')
  }
  if (dialect === 'sglang' && body.tool_choice === 'required' && !body.tools?.length) return refuse('Tools cannot be empty if tool choice is set to required.')
  if (dialect === 'sglang' && typeof body.reasoning_effort === 'boolean') return { status: 400, body: { object: 'error', message: 'Value error, reasoning_effort must not be a boolean', type: 'Bad Request', param: null, code: 400 } }
  if ((dialect === 'vllm' || dialect === 'sglang') && body.reasoning_effort != null && !efforts.includes(body.reasoning_effort)) {
    if (!(dialect === 'sglang' && typeof body.reasoning_effort === 'number' && body.reasoning_effort >= 0 && body.reasoning_effort <= 0.99)) return refuse('reasoning_effort: Input should be none, minimal, low, medium, high, xhigh or max', 'reasoning_effort')
  }
  for (const message of body.messages ?? []) {
    if (dialect === 'ollama') for (const call of message.tool_calls ?? []) {
      try { JSON.parse(call.function.arguments) } catch { return refuse('invalid tool call arguments') }
    }
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type !== 'image_url') continue
      if (dialect === 'llamacpp' && config.images === false) return refuse('image input is not supported - hint: if this is unexpected, you may need to provide the mmproj')
      if (dialect === 'ollama') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
        if (/^https?:\/\//.test(url)) return refuse('image URLs are not currently supported, please use base64 encoded data instead')
        if (typeof url !== 'string' || !/^data:(?:image\/(?:png|jpeg|jpg|webp))?;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) return refuse('invalid image input')
      }
    }
  }
  return undefined
}

export async function startEngineRules(dialect, config = {}) {
  if (!(dialect in ENGINE_RULE_SOURCES)) throw new Error(`No rules for ${dialect}`)
  const model = typeof config.model === 'string' && config.model ? config.model : 'engine-fixture'
  const requests = []
  const queue = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url === '/v1/models') return json(200, { object: 'list', data: [{ id: model, owned_by: dialect, ...(dialect === 'vllm' || dialect === 'sglang' ? { max_model_len: 131072 } : {}) }] })
    const path = req.url.split('?')[0]
    const named = new URL(req.url, 'http://127.0.0.1').searchParams.get('model')
    const routed = dialect === 'llamacpp' && config.router === true
    const missingModel = () => json(400, { error: { code: 400, message: 'model name is missing from the request', type: 'invalid_request_error' } })
    if (path === '/props' && dialect === 'llamacpp') {
      if (routed && named === null) return json(200, { role: 'router', max_instances: 4, models_autoload: true, model_alias: 'llama-server', model_path: 'none', default_generation_settings: { params: {}, n_ctx: 0 }, ui_settings: {}, build_info: 'b0-fixture' })
      if (routed && named !== model) return json(400, { error: { code: 400, message: `model '${named}' not found`, type: 'invalid_request_error' } })
      return json(200, { default_generation_settings: { n_ctx: 131072 }, total_slots: 1, modalities: { vision: config.images ?? true }, chat_template_caps: { supports_tools: config.tools ?? true, supports_tool_calls: config.tools ?? true, supports_reasoning_effort: config.reasoning ?? true, supports_preserve_reasoning: config.reasoning ?? true } })
    }
    if (path === '/slots' && dialect === 'llamacpp') {
      if (routed && named === null) return missingModel()
      return json(200, [{ id: 0, id_task: -1, n_ctx: 131072, is_processing: false }])
    }
    if (req.url === '/metrics' && dialect === 'sglang') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end(`sglang:prompt_tokens_total{model_name="${model}"} 1000\nsglang:time_to_first_token_seconds_sum{model_name="${model}"} 2\n`) }
    if (path === '/metrics' && dialect === 'llamacpp') {
      if (routed && named === null) return missingModel()
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end('llamacpp:prompt_tokens_seconds 1234\n')
    }
    if ((req.url === '/model_info' && config.legacyOnly !== true || req.url === '/get_model_info' && (config.legacyInfo === true || config.legacyOnly === true)) && dialect === 'sglang') return json(200, { model_path: model, served_model_name: model, tokenizer_path: model, is_generation: true, preferred_sampling_params: null, weight_version: 'default', load_format: 'auto', reasoning_parser: config.reasoning === false ? null : config.reasoningParser ?? 'qwen3', tool_call_parser: config.tools === false ? null : config.toolParser ?? 'qwen', disaggregation_mode: 'null', has_image_understanding: config.images ?? true, has_audio_understanding: false, model_type: config.modelType ?? 'qwen3', architectures: [config.architecture ?? 'Qwen3ForCausalLM'] })
    if (req.url === '/api/tags' && dialect === 'ollama') return json(200, { models: [{ name: model }] })
    if (req.url === '/api/ps' && dialect === 'ollama') return json(200, { models: [{ name: model, context_length: 131072 }] })
    if (req.url === '/api/show' && dialect === 'ollama') return json(200, { capabilities: ['completion', ...(config.images === false ? [] : ['vision']), ...(config.tools === false ? [] : ['tools']), ...(config.reasoning === false ? [] : ['thinking'])], thinking: { values: ['low', 'medium', 'high', 'max'], default: 'high' } })
    if (req.url !== '/v1/chat/completions') return json(404, { error: 'not found' })
    const fault = validateEngineRequest(dialect, body, config)
    requests.push({ body, fault, ...(dialect === 'sglang' ? { deepseekV4Thinking: deepseekV4ThinkingMode(body) } : {}) })
    if (fault) return json(fault.status, fault.body)
    const turn = queue.shift() ?? {}
    if (turn.error) return json(turn.error.status, turn.error.body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = value => res.write(`data: ${JSON.stringify(value)}\n\n`)
    if (turn.usage) event({ model, choices: [], usage: turn.usage })
    if (turn.empty) { res.end(); return }
    if (turn.reasoning) event({ model, choices: [{ delta: { [dialect === 'ollama' || dialect === 'vllm' ? 'reasoning' : 'reasoning_content']: turn.reasoning } }] })
    if (turn.call) event({ model, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_engine', type: 'function', function: turn.call }] } }] })
    else event({ model, choices: [{ delta: { content: 'engine accepted' } }] })
    if (turn.hold) return
    if (turn.cut) { res.end(); return }
    event({ model, choices: [{ delta: {}, finish_reason: turn.call ? 'length' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } })
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  return { dialect, model, baseUrl, requests, script: turns => queue.push(...turns), close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
