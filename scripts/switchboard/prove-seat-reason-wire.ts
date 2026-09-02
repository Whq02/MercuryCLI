#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const {
  encodeDecisionReasonForWire,
  decodeDecisionReasonFromWire,
} = await import('../../src/utils/permissions/decisionReasonWire.ts')
type Reason = NonNullable<ReturnType<typeof decodeDecisionReasonFromWire>>

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const trip = (reason: Reason): unknown =>
  decodeDecisionReasonFromWire(JSON.parse(JSON.stringify(encodeDecisionReasonForWire(reason))))

const rule: Reason = {
  type: 'rule',
  rule: {
    source: 'userSettings',
    ruleBehavior: 'ask',
    ruleValue: { toolName: 'Bash', ruleContent: 'rm:*' },
  } as never,
}
const plain: Reason[] = [
  rule,
  { type: 'mode', mode: 'default' },
  { type: 'hook', hookName: 'guard', hookSource: 'project', reason: 'the hook says ask' },
  { type: 'classifier', classifier: 'auto-mode', reason: 'the check said no' },
  { type: 'workingDir', reason: 'outside the workspace' },
  { type: 'safetyCheck', reason: 'a sensitive path', classifierApprovable: true },
  { type: 'other', reason: 'free text' },
  { type: 'asyncAgent', reason: 'a background agent asks' },
  { type: 'sandboxOverride', reason: 'excludedCommand' },
  { type: 'permissionPromptTool', permissionPromptToolName: 'stdio' },
]
for (const r of plain) {
  check(`R1 ${r.type} round-trips byte-identical`, JSON.stringify(trip(r)) === JSON.stringify(r), JSON.stringify(trip(r)))
}

const compound: Reason = {
  type: 'subcommandResults',
  reasons: new Map([
    ['rm -f x', { behavior: 'ask', message: 'asks', decisionReason: rule } as never],
    ['echo done', { behavior: 'allow', decisionReason: { type: 'mode', mode: 'flow' } } as never],
    ['ls', { behavior: 'passthrough', message: 'no rule' } as never],
  ]),
}
const encoded = encodeDecisionReasonForWire(compound) as { reasons?: unknown }
check('R2 the Map crosses as an entry list', Array.isArray(encoded.reasons) && (encoded.reasons as unknown[]).length === 3)
check('R2 …and JSON keeps it whole', JSON.parse(JSON.stringify(encoded)).reasons.length === 3)
const back = trip(compound) as { type?: string; reasons?: Map<string, { behavior?: string; decisionReason?: Reason }> }
check('R2 it comes back a Map of three parts', back.type === 'subcommandResults' && back.reasons instanceof Map && back.reasons.size === 3)
check('R2 a part\'s own rule reason is decoded (nested)', back.reasons?.get('rm -f x')?.decisionReason?.type === 'rule' && JSON.stringify(back.reasons.get('rm -f x')?.decisionReason) === JSON.stringify(rule))
check('R2 a part\'s mode reason is decoded', back.reasons?.get('echo done')?.decisionReason?.type === 'mode')
check('R2 a part with no reason keeps none', back.reasons?.get('ls')?.behavior === 'passthrough' && back.reasons.get('ls')?.decisionReason === undefined)

const poison: Array<[string, unknown]> = [
  ['a string', 'The rule Bash(rm:*) requires confirmation'],
  ['null', null],
  ['an unknown type', { type: 'legend', reason: 'x' }],
  ['a rule without a ruleValue', { type: 'rule', rule: { source: 'userSettings' } }],
  ['a hook without a name', { type: 'hook', reason: 'x' }],
  ['a safetyCheck without the approvable bit', { type: 'safetyCheck', reason: 'x' }],
  ['a mode without a mode', { type: 'mode' }],
  ['other without text', { type: 'other' }],
  ['subcommandResults without entries', { type: 'subcommandResults', reasons: 'nope' }],
]
for (const [label, value] of poison) {
  check(`R3 poison: ${label} decodes to nothing`, decodeDecisionReasonFromWire(value) === undefined, JSON.stringify(decodeDecisionReasonFromWire(value)))
}
check('R3 poison: a subcommandResults entry that is not a pair is dropped, the well-formed ones kept', (() => {
  const d = decodeDecisionReasonFromWire({ type: 'subcommandResults', reasons: [['ok', { behavior: 'ask' }], 'junk', ['half']] }) as { reasons?: Map<string, unknown> } | undefined
  return d?.reasons instanceof Map && d.reasons.size === 1 && d.reasons.has('ok')
})())
check('R3 encode(undefined) is undefined (no fabricated field on the wire)', encodeDecisionReasonForWire(undefined) === undefined)

check(
  'R4 the structured form carries the rule the card names (Bash(rm:*))',
  (trip(rule) as { rule?: { ruleValue?: { toolName?: string; ruleContent?: string } } }).rule?.ruleValue?.toolName === 'Bash' &&
    (trip(rule) as { rule?: { ruleValue?: { ruleContent?: string } } }).rule?.ruleValue?.ruleContent === 'rm:*',
)

console.log(failures === 0 ? '\n ✅ THE DECISION REASON CROSSES THE DOORWAY WHOLE' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
