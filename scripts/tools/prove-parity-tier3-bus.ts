#!/usr/bin/env bun
import { absorbWithinPendingCap } from '../../src/hooks/useInboxPoller.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const msg = (n: number) => ({ from: `peer${n}`, timestamp: `2026-08-22T00:00:${String(n).padStart(2, '0')}.000Z`, text: `m${n}` })
const key = (m: { from: string; timestamp: string; text: string }) => `${m.from} ${m.timestamp} ${m.text}`

const cap = 5

const under = absorbWithinPendingCap(0, [msg(1), msg(2)], cap)
t('under capacity absorbs all', under.absorbed.length === 2 && under.refusedKeys.size === 0)

const full = absorbWithinPendingCap(cap, [msg(1), msg(2)], cap)
t('at capacity absorbs none', full.absorbed.length === 0)
t('at capacity refuses all incoming', full.refusedKeys.size === 2 && full.refusedKeys.has(key(msg(1))))

const partial = absorbWithinPendingCap(3, [msg(1), msg(2), msg(3)], cap)
t('partial room absorbs oldest-first up to the cap', partial.absorbed.length === 2)
t(
  'partial room refuses exactly the overflow (newest)',
  partial.refusedKeys.size === 1 && partial.refusedKeys.has(key(msg(3))) && !partial.refusedKeys.has(key(msg(1))),
)

const deliveredKeys = new Set([msg(1), msg(2), msg(3)].map(key))
const marked = [msg(1), msg(2), msg(3)].filter(m => deliveredKeys.has(key(m)) && !partial.refusedKeys.has(key(m)))
t('a refused message is NOT marked read (stays unread on disk)', marked.length === 2 && !marked.map(key).includes(key(msg(3))))

const over = absorbWithinPendingCap(cap + 3, [msg(1)], cap)
t('an over-capacity buffer refuses (no negative room)', over.absorbed.length === 0 && over.refusedKeys.size === 1)

const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const nameField = (name: string) =>
  AgentTool.inputSchema.safeParse({ description: 'd', prompt: 'p', name })
t('a plain name is accepted', nameField('reviewer-2').success === true)
t('an unusual-but-safe name is accepted', nameField('café.worker_01').success === true)
t("a name containing '@' is rejected (unmessageable)", nameField('worker@team').success === false)
t("the name '*' is rejected (broadcast token)", nameField('*').success === false)
t('an omitted name is still valid', AgentTool.inputSchema.safeParse({ description: 'd', prompt: 'p' }).success === true)

process.exit(failures)
