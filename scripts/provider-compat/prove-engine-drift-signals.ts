import { ENGINE_RULE_SOURCES } from './fixtures/engineRules.mjs'

if (process.env.MERCURY_DRIFT_SIGNALS !== '1') {
  console.log('engine drift signals not read: this proof reads the engines’ live source and docs; run it as a reading with MERCURY_DRIFT_SIGNALS=1')
  process.exit(0)
}
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')

let checks = 0
let failures = 0
const check = (name: string, value: unknown, detail: unknown = ''): void => {
  checks++
  if (!value) failures++
  console.log((value ? 'PASS ' : 'FAIL ') + name + (value ? '' : ' — ' + JSON.stringify(detail)))
}
const raw = (blob: string): string => blob.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/')
const read = async (url: string): Promise<string> => {
  const response = await fetch(url, { headers: { 'user-agent': 'mercury-drift-signals/1' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(url + ' answered HTTP ' + response.status)
  return response.text()
}
const head = async (repo: string, branch: string): Promise<string> => {
  try {
    const response = await fetch('https://api.github.com/repos/' + repo + '/commits/' + branch, { headers: { 'user-agent': 'mercury-drift-signals/1', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) })
    const body = await response.json() as { sha?: string; commit?: { committer?: { date?: string } } }
    return (body.sha ?? '?').slice(0, 10) + ' ' + (body.commit?.committer?.date ?? '')
  } catch { return 'unread' }
}
const names = (text: string, words: string[]): string[] => words.filter(word => !text.includes(word))

{
  const sources = ENGINE_RULE_SOURCES.llamacpp
  console.log('llama.cpp master ' + await head('ggml-org/llama.cpp', 'master'))
  const readme = await read(raw(sources.discovery))
  const props = names(readme, ['### **GET** `/props`', '"total_slots"', '"default_generation_settings"', '"chat_template_caps"', '"modalities"', '"vision"', '"is_sleeping"'])
  check('llama.cpp still documents GET /props with total_slots, default_generation_settings, chat_template_caps, modalities.vision and is_sleeping (' + sources.discovery + ')', props.length === 0, props)
  const slots = names(readme, ['### GET `/slots`', '"is_processing"', '`--no-slots`'])
  check('llama.cpp still documents GET /slots rows with is_processing', slots.length === 0, slots)
  const metrics = names(readme, ['### GET `/metrics`', '`llamacpp:prompt_tokens_seconds`', '`--metrics`'])
  check('llama.cpp still exports llamacpp:prompt_tokens_seconds behind --metrics', metrics.length === 0, metrics)
  const routerRule = /For \*\*GET\*\* endpoints \(`\/props`, `\/metrics`, etc\.\) The router uses the `model` query parameter/.test(readme)
  check('llama.cpp router mode still routes GET /props and /metrics by the model query parameter', routerRule)
  const knobs = names(readme, ['`id_slot`', '`cache_prompt`', '`reasoning_format`', '`-mm, --mmproj FILE`'])
  check('llama.cpp still takes id_slot, cache_prompt, reasoning_format and --mmproj', knobs.length === 0, knobs)
  const caps = await read(raw(sources.capabilities))
  const capNames = names(caps, ['supports_tools', 'supports_tool_calls', 'supports_reasoning_effort', 'supports_preserve_reasoning'])
  check('llama.cpp chat_template_caps still name supports_tools, supports_tool_calls, supports_reasoning_effort and supports_preserve_reasoning (' + sources.capabilities + ')', capNames.length === 0, capNames)
  const schema = await read(raw(sources.schema))
  const refWords = names(schema, ['$ref must be a string', 'only references into the same document are supported', 'cannot resolve $ref'])
  check('llama.cpp’s schema reader still refuses with the $ref words the refusal table matches (' + sources.schema + ')', refWords.length === 0, refWords)
  check('llama.cpp’s schema reader still resolves same-document $ref targets (the pre-check accepts what the engine accepts)', /ref\.compare\(0, 2, "#\/"\) != 0/.test(schema) && /resolve_ref\(/.test(schema))
  const context = await read('https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-context.cpp')
  const propKeys = names(context, ['{ "total_slots",', '{ "default_generation_settings",', '{ "chat_template_caps",', '{"vision", meta.has_inp_image}', '{"is_processing", is_processing()}'])
  check('the /props and /slots keys the probe reads are the ones server-context.cpp writes', propKeys.length === 0, propKeys)
}

{
  const sources = ENGINE_RULE_SOURCES.sglang
  console.log('sglang main ' + await head('sgl-project/sglang', 'main'))
  const server = await read(raw(sources.discovery))
  check('SGLang still serves GET /model_info (' + sources.discovery + ')', /@app\.get\("\/model_info"\)/.test(server))
  const retired = /Endpoint '\/get_model_info' is deprecated/.test(server)
  const stillThere = /@app\.get\("\/get_model_info"\)/.test(server)
  console.log('      /get_model_info: ' + (stillThere ? 'still served' + (retired ? ', deprecated' : '') : 'removed — the fallback path is dead and can go'))
  const keys = names(server, ['"model_path":', '"served_model_name":', '"has_image_understanding":', '"tool_call_parser":', '"reasoning_parser":'])
  check('SGLang /model_info still carries model_path, served_model_name, has_image_understanding, tool_call_parser and reasoning_parser', keys.length === 0, keys)
  check('SGLang /model_info still does not carry context_length (the window rides /v1/models max_model_len)', !/"context_length":/.test(server.slice(server.indexOf('async def model_info'), server.indexOf('async def get_server_info'))))
  const protocol = await read(raw(sources.envelope))
  check('SGLang ModelCard still carries max_model_len (' + sources.envelope + ')', /class ModelCard\(BaseModel\):[\s\S]*?max_model_len: Optional\[int\]/.test(protocol))
  const requestFields = names(protocol, ['separate_reasoning: bool = True', 'reasoning_effort:', 'chat_template_kwargs:'])
  check('SGLang chat requests still take separate_reasoning, reasoning_effort and chat_template_kwargs', requestFields.length === 0, requestFields)
  check('SGLang still refuses a boolean reasoning_effort with the words the engine fixture uses', /reasoning_effort must not be a boolean/.test(protocol))
  check('SGLang still names max_model_len from model_config.context_len on /v1/models', /max_model_len=_global_state\.tokenizer_manager\.model_config\.context_len/.test(server))
  const fieldFiles = ['device', 'disagg', 'exec_', 'lora', 'memory', 'mm', 'model', 'observability', 'parallel', 'schedule', 'serving', 'spec']
  const fields: string[] = []
  for (const name of fieldFiles) fields.push(...(await read('https://raw.githubusercontent.com/sgl-project/sglang/main/python/sglang/srt/arg_groups/fields/' + name + '.py')).matchAll(/^ {4}([a-z][a-z0-9_]*): A\[/gm).map(match => match[1]!))
  const tpLike = fields.filter(name => /^(tp|dp)[a-z0-9]*_/.test(name) && name !== 'tp_size' && name !== 'dp_size')
  check('the recipes’ --tp and --dp spellings stay unambiguous argparse prefixes of SGLang’s tp_size and dp_size (' + fields.length + ' fields read; the cookbooks use the short forms)', fields.includes('tp_size') && fields.includes('dp_size') && tpLike.length === 0, { tpLike, fields: fields.length })
  const arguments_ = await read('https://raw.githubusercontent.com/sgl-project/sglang/main/python/sglang/srt/arg_groups/arg_utils.py')
  check('SGLang still derives --flag-names from field names with argparse (so the prefix rule above is the one that admits --tp)', /return "--" \+ name\.replace\("_", "-"\)/.test(arguments_) && !/allow_abbrev\s*=\s*False/.test(arguments_))
  const serving = await read('https://raw.githubusercontent.com/sgl-project/sglang/main/python/sglang/srt/arg_groups/fields/serving.py')
  check('SGLang still takes --enable-cache-report (the flag every SGLang recipe adds)', /^ {4}enable_cache_report: A\[/m.test(serving))
}

{
  const sources = ENGINE_RULE_SOURCES.vllm
  console.log('vllm main ' + await head('vllm-project/vllm', 'main'))
  const request = await read(raw(sources.request))
  check('vLLM chat deltas still carry reasoning (reasoning_content renamed on the way in) (' + sources.request + ')', /reasoning: str \| None = None/.test(request) && /reasoning_content/.test(request))
  check('vLLM reasoning_effort still accepts none, minimal, low, medium, high, xhigh and max', /Literal\["none", "minimal", "low", "medium", "high", "xhigh", "max"\]/.test(request))
  const envelope = await read(raw(sources.envelope))
  check('vLLM ModelCard still carries max_model_len (' + sources.envelope + ')', /class ModelCard\(OpenAIBaseModel\):[\s\S]*?max_model_len: int \| None = None/.test(envelope))
  const tools = await fetch(sources.tools, { headers: { 'user-agent': 'mercury-drift-signals/1' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  const toolsText = await tools.text()
  check('vLLM tool-calling docs still name --enable-auto-tool-choice and --tool-call-parser (' + sources.tools + ')', tools.ok && /enable-auto-tool-choice/.test(toolsText) && /tool-call-parser/.test(toolsText), tools.status)
}

{
  const sources = ENGINE_RULE_SOURCES.ollama
  console.log('ollama main ' + await head('ollama/ollama', 'main'))
  const types = await read(raw(sources.discovery))
  const show = /type ShowResponse struct \{[\s\S]*?\n\}/.exec(types)?.[0] ?? ''
  const showKeys = names(show, ['`json:"thinking,omitempty"`', '`json:"capabilities,omitempty"`', '`json:"parameters,omitempty"`'])
  check('Ollama /api/show still carries thinking, capabilities and parameters (' + sources.discovery + ')', showKeys.length === 0, showKeys)
  const ps = /type ProcessModelResponse struct \{[\s\S]*?\n\}/.exec(types)?.[0] ?? ''
  check('Ollama /api/ps rows still carry context_length', /`json:"context_length"`/.test(ps))
  const caps = await read(raw(sources.capabilities))
  const capNames = names(caps, ['Capability("tools")', 'Capability("vision")', 'Capability("thinking")'])
  check('Ollama capabilities still spell tools, vision and thinking (' + sources.capabilities + ')', capNames.length === 0, capNames)
  const thinking = await read('https://raw.githubusercontent.com/ollama/ollama/main/types/model/thinking.go')
  check('Ollama’s thinking descriptor still carries values[] and default', /Values\s+\[\]any\s+`json:"values"`/.test(thinking) && /Default\s+any\s+`json:"default"`/.test(thinking))
  const docs = await fetch(sources.fields, { headers: { 'user-agent': 'mercury-drift-signals/1' }, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  check('Ollama’s OpenAI-compatibility page still answers (' + sources.fields + ')', docs.ok, docs.status)
}

console.log('prove-engine-drift-signals: ' + checks + ' checks, ' + failures + ' failed')
process.exitCode = failures ? 1 : 0
