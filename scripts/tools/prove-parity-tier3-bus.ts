#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = '', failHint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && failHint ? ` — ${failHint}` : ''}`)
  if (!ok) failures = 1
}

const { AgentTool } = await import('../../src/tools/crewmate/CrewmateTool.tsx')
const nameField = (name: string) =>
  AgentTool.inputSchema.safeParse({ description: 'd', prompt: 'p', name })
t('a plain name is accepted', nameField('reviewer-2').success === true, '', 'Make the name field of inputSchema in src/tools/crewmate/call/schema.ts accept an ordinary name.')
t('an unusual-but-safe name is accepted', nameField('café.worker_01').success === true, '', 'Make the name field of inputSchema in src/tools/crewmate/call/schema.ts accept letters, dots and underscores.')
t("a name containing '@' is rejected (unmessageable)", nameField('worker@crew').success === false, '', 'Restore the @ rejection in the name refine of inputSchema in src/tools/crewmate/call/schema.ts.')
t("the name '*' is rejected (broadcast token)", nameField('*').success === false, '', 'Restore the rejection of the name * in the name refine of inputSchema in src/tools/crewmate/call/schema.ts.')
t('an omitted name is still valid', AgentTool.inputSchema.safeParse({ description: 'd', prompt: 'p' }).success === true, '', 'Keep name optional in inputSchema in src/tools/crewmate/call/schema.ts.')

process.exit(failures)
