import type { CreateElicitationRequest, ElicitationPropertySchema } from '@agentclientprotocol/sdk'
import type { PermissionAnswer } from '../../runner/wire/methods.js'
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import type { ToolAsk } from './childSession.js'

export function questionFormOf(ask: ToolAsk, sessionId: string): {
  request: CreateElicitationRequest
  answer: (result: unknown) => PermissionAnswer
} | null {
  const parsed = AskUserQuestionTool.inputSchema.safeParse(ask.input)
  if (!parsed.success) return null
  const input = parsed.data
  const keys = input.questions.map(question => question.id ?? question.question)
  if (new Set(keys).size !== keys.length) return null
  const used = new Set(keys)
  const fresh = (base: string): string => {
    let key = base
    while (used.has(key)) key += '_'
    used.add(key)
    return key
  }
  const fields = input.questions.map((question, index) => {
    const choices = question.options.map(option => ({
      const: option.id ?? option.label,
      title: option.label,
      description: [option.description, option.preview].filter(Boolean).join('\n\n'),
      _meta: { 'mercury/option': option },
    }))
    let other = 'other'
    while (choices.some(option => option.const === other)) other += '_'
    return { key: keys[index]!, question, choices, other, custom: fresh(`${keys[index]}__other`) }
  })
  if (fields.some(field => new Set(field.choices.map(option => option.const)).size !== field.choices.length)) return null
  const properties: Record<string, ElicitationPropertySchema> = Object.create(null)
  for (const field of fields) {
    const choices = [...field.choices, { const: field.other, title: 'Other', description: 'Write your answer in the accompanying text field.' }]
    const common = { title: field.question.question, _meta: { 'mercury/question': field.question } }
    properties[field.key] = field.question.multiSelect
      ? { ...common, type: 'array', minItems: 1, maxItems: choices.length, items: { anyOf: choices } }
      : { ...common, type: 'string', oneOf: choices }
    properties[field.custom] = { type: 'string', title: `${field.question.header}: other answer` }
  }
  return {
    request: {
      sessionId,
      toolCallId: ask.tool_use_id,
      mode: 'form',
      message: "Answer Mercury's questions",
      requestedSchema: { type: 'object', title: "Answer Mercury's questions", properties, required: keys },
      _meta: { 'mercury/input': ask.input },
    },
    answer(result): PermissionAnswer {
      const denied: PermissionAnswer = { outcome: 'deny', message: 'The editor did not submit a complete answer to the questions.' }
      if (!result || typeof result !== 'object') return denied
      const { action, content } = result as { action?: unknown; content?: unknown }
      if (action !== 'accept' || !content || typeof content !== 'object' || Array.isArray(content)) return denied
      const submitted = content as Record<string, unknown>
      const answers: Record<string, string> = Object.create(null)
      const annotations = { ...input.annotations }
      for (const field of fields) {
        const value = submitted[field.key]
        if (field.question.multiSelect ? !Array.isArray(value) : typeof value !== 'string') return denied
        const selected: unknown[] = Array.isArray(value) ? value : [value]
        if (selected.length === 0 || new Set(selected).size !== selected.length) return denied
        const labels: string[] = []
        const previews: string[] = []
        for (const choice of selected) {
          if (typeof choice !== 'string') return denied
          if (choice === field.other) {
            const custom = submitted[field.custom]
            if (typeof custom !== 'string' || custom.trim() === '') return denied
            labels.push(custom)
          } else {
            const option = field.question.options.find(option => (option.id ?? option.label) === choice)
            if (!option) return denied
            labels.push(option.label)
            if (option.preview) previews.push(option.preview)
          }
        }
        answers[field.key] = labels.join(', ')
        const annotation = { ...annotations[field.key] }
        delete annotation.preview
        if (previews.length) annotation.preview = previews.join('\n\n')
        if (Object.keys(annotation).length) annotations[field.key] = annotation
        else delete annotations[field.key]
      }
      return {
        outcome: 'allow',
        input: {
          ...ask.input,
          answers,
          annotations,
          outcome: { kind: 'answers-submitted' },
        },
      }
    },
  }
}
