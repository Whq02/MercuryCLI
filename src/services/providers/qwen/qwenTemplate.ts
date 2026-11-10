export const QWEN_TEMPLATE_EFFORTS: readonly string[] = ['low', 'medium', 'xhigh']

export const QWEN_TEMPLATE_EFFORT_STEPS: Readonly<Record<string, string>> = {
  none: 'low',
  minimal: 'low',
  high: 'xhigh',
  max: 'xhigh',
}

export function qwenTemplateEffort(effort: string): string | undefined {
  const word = QWEN_TEMPLATE_EFFORT_STEPS[effort] ?? effort
  return QWEN_TEMPLATE_EFFORTS.includes(word) ? word : undefined
}

const GENERATION_RE = /(?:^|[^a-z0-9])qwen[-_ ]?([0-9])(?:[._]([0-9]+))?(?=[-:_. ]|$)/

export function qwenTemplateReadsEffort(id: string): boolean {
  const generation = GENERATION_RE.exec(id.toLowerCase())
  if (generation === null) return false
  const major = Number(generation[1])
  return major > 3 || (major === 3 && Number(generation[2] ?? 0) >= 8)
}
