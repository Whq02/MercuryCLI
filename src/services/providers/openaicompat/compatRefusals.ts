const ENGINE_NAMES: Readonly<Record<string, string>> = {
  llamacpp: 'llama.cpp', vllm: 'vLLM', sglang: 'SGLang', ollama: 'Ollama', lmstudio: 'LM Studio',
}

const TOOL_REMEDY = 'select a tool-capable model or enable the model’s tool parser on this server, then retry'
const REFUSALS: readonly { dialects?: readonly string[]; match: RegExp; remedy: string }[] = [
  { dialects: ['llamacpp'], match: /(?:unsupported|unresolved|cannot resolve|not found).*\$ref|\$ref.*(?:not found|must be)/i, remedy: 'update the named tool to a self-contained schema before retrying' },
  { dialects: ['llamacpp'], match: /mmproj|vision projector/i, remedy: 'start this model with its matching vision projector, or select a server that reports image support in /model' },
  { dialects: ['vllm'], match: /enable.auto.tool.choice|tool.call.parser/i, remedy: 'start vLLM with --enable-auto-tool-choice and the model’s --tool-call-parser, then retry' },
  { dialects: ['sglang'], match: /tool.call.parser|reasoning.parser/i, remedy: 'configure SGLang with the model’s matching tool or reasoning parser, then retry' },
  { match: /tool_call_id/i, remedy: 'include the matching tool_call_id from the assistant’s tool call, then retry' },
  { match: /tool_choice|tool choice/i, remedy: 'send the matching tool declaration with the tool choice, then retry' },
  { match: /reasoning_effort|reasoning effort|separate_reasoning|reasoning_format/i, remedy: 'configure the server for the requested reasoning setting, then retry; the selected effort is unchanged' },
  { dialects: ['ollama'], match: /image URLs are not currently supported/i, remedy: 'send the image as a base64 data URI instead of an HTTP URL' },
  { dialects: ['ollama'], match: /invalid image input/i, remedy: 'send a valid base64 PNG, JPEG or WebP image' },
  { match: /invalid tool call arguments|tool.*arguments.*(?:JSON|parse)/i, remedy: 'send complete JSON arguments for the tool call before retrying' },
  { match: /does not support tools|tools.*not supported/i, remedy: TOOL_REMEDY },
  { match: /image.*(?:not supported|unsupported)|(?:not support|unsupported).*image/i, remedy: 'select a server that reports image support in /model, then retry' },
]

export function compatEngineRefusalText(dialect: string | undefined, fault: { message: string; status?: number }): string | undefined {
  const name = dialect === undefined ? undefined : ENGINE_NAMES[dialect]
  if (!name || fault.status === undefined || fault.status < 400) return undefined
  const detail = fault.message.trim() || 'the server returned no error detail'
  const rule = REFUSALS.find(rule => (!rule.dialects || rule.dialects.includes(dialect!)) && rule.match.test(detail))
  return `${name} refused the request: ${detail} — ${rule?.remedy ?? 'check this server’s model and request settings, then retry; /llmhost checks the connection'}`
}

export function compatToolSupportRefusal(dialect: string, model: string): string {
  return `${ENGINE_NAMES[dialect] ?? 'This server'} reports no tool-call support for '${model}' — ${TOOL_REMEDY}`
}
