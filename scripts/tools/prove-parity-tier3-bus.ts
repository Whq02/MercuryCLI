#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const nameField = (name: string) =>
  AgentTool.inputSchema.safeParse({ description: 'd', prompt: 'p', name })
t('a plain name is accepted', nameField('reviewer-2').success === true)
t('an unusual-but-safe name is accepted', nameField('café.worker_01').success === true)
t("a name containing '@' is rejected (unmessageable)", nameField('worker@crew').success === false)
t("the name '*' is rejected (broadcast token)", nameField('*').success === false)
t('an omitted name is still valid', AgentTool.inputSchema.safeParse({ description: 'd', prompt: 'p' }).success === true)

process.exit(failures)
