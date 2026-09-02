#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-push-notification-honest.ts
//  PROOF (Feature C): PushNotification reports localSent + the "sent" claim ONLY
//  when a notification was ACTUALLY delivered.
//
//  The bug: the tool set localSent=true and the result fell through to "Terminal
//  notification sent." whenever a notify CHANNEL existed — even when the channel
//  resolved to a NON-delivery sentinel (no_method_available/none/disabled/error),
//  i.e. the message was dropped silently. The fix reads the dispatched method
//  back from the channel (services/notifier.ts → sendNotification returns it,
//  now plumbed through ToolUseContext.sendOSNotification + REPL.tsx) and gates
//  localSent on a REAL delivery method.
//
//  This drives the REAL tool: PushNotificationTool.call() with a fake context
//  whose sendOSNotification returns each method/sentinel, then renders the result
//  via the tool's OWN mapToolResultToToolResultBlockParam — asserting both the
//  output flag AND the model-visible claim.
//
//  Run:  ~/.bun/bin/bun run scripts/permissions/prove-push-notification-honest.ts
// ============================================================================

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' PushNotification honest-delivery (Feature C) — behavior proof')
console.log('============================================================')

const { PushNotificationTool } = await import(
  '../../src/tools/PushNotificationTool/PushNotificationTool.js'
)

// Drive the REAL tool with a channel that resolves to `method`. Returns the
// output flag + the model-visible result content the renderer produces.
async function run(method: string | void | undefined): Promise<{
  localSent: boolean | undefined
  disabledReason: string | undefined
  content: string
}> {
  const ctx: any = { sendOSNotification: async () => method }
  const { data } = await (PushNotificationTool as any).call(
    { message: 'build failed: 2 auth tests', status: 'proactive' },
    ctx,
  )
  const block = (PushNotificationTool as any).mapToolResultToToolResultBlockParam(
    data,
    'tu_1',
  )
  return {
    localSent: data.localSent,
    disabledReason: data.disabledReason,
    content: String(block.content),
  }
}

const SENT_CLAIM = /notification sent\./i

section('REAL delivery methods → localSent:true + a "sent" claim')
{
  for (const m of ['iterm2', 'iterm2_with_bell', 'kitty', 'ghostty', 'terminal_bell']) {
    const r = await run(m)
    check(`${m}: localSent === true`, r.localSent === true, JSON.stringify(r))
    check(`${m}: result claims a send`, SENT_CLAIM.test(r.content) && /Terminal/.test(r.content))
    check(`${m}: no_transport NOT set`, r.disabledReason === undefined)
  }
}

section('NON-delivery sentinels → localSent:false + NO "sent" claim (the bug, fixed)')
{
  for (const m of ['no_method_available', 'none', 'disabled', 'error']) {
    const r = await run(m)
    check(`${m}: localSent === false (does NOT claim a send)`, r.localSent === false, JSON.stringify(r))
    check(`${m}: result does NOT claim a send`, !SENT_CLAIM.test(r.content), r.content)
    check(`${m}: result says NOT sent`, /Not sent/i.test(r.content))
    check(`${m}: disabledReason === 'no_transport'`, r.disabledReason === 'no_transport')
  }
}

section('degenerate channels → fail-honest (no false claim)')
{
  // A channel wired as `void` (older ToolUseContext) returns undefined → unknown
  // delivery → must NOT claim a send.
  const v = await run(undefined)
  check('void/undefined-return channel: localSent === false', v.localSent === false, JSON.stringify(v))
  check('void/undefined-return channel: no "sent" claim', !SENT_CLAIM.test(v.content))

  // No channel at all (SDK / non-interactive).
  const ctx: any = {}
  const { data } = await (PushNotificationTool as any).call({ message: 'x', status: 'proactive' }, ctx)
  check('no channel: localSent === false', data.localSent === false, JSON.stringify(data))
  check("no channel: disabledReason === 'no_transport'", data.disabledReason === 'no_transport')

  // pushSent is ALWAYS false on the fork (no mobile transport) — never a false claim.
  check('pushSent is always false (no fork mobile transport)', data.pushSent === false)
}

section('source: the method is plumbed end-to-end (notifier → context → REPL → tool)')
{
  const src = (...p: string[]) =>
    readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
  const notifier = src('services', 'notifier.ts')
  check('notifier.sendNotification returns the dispatched method (Promise<string>)', /export async function sendNotification[\s\S]*?\): Promise<string>/.test(notifier) && notifier.includes('return methodUsed'))

  const tool = src('tools', 'PushNotificationTool', 'PushNotificationTool.ts')
  check('the tool gates localSent on a REAL delivery method (LOCAL_DELIVERY_METHODS)', tool.includes('LOCAL_DELIVERY_METHODS.has(methodUsed)') && tool.includes('methodUsed !== undefined'))
  check('the tool sets no_transport when nothing went out', /if \(!localSent && !pushSent\)[\s\S]*?disabledReason = 'no_transport'/.test(tool))
  // The sentinels must NOT be members of LOCAL_DELIVERY_METHODS — proved at
  // runtime above (each sentinel ⇒ localSent:false). Here assert the SET literal
  // (between `new Set([` and `])`) lists only the real delivery methods, so a
  // sentinel can never be added by mistake. (Comment prose elsewhere in the file
  // legitimately names the sentinels, so a whole-file grep would false-negative.)
  const setLiteral = (tool.match(/LOCAL_DELIVERY_METHODS = new Set<string>\(\[([\s\S]*?)\]\)/) || [])[1] ?? ''
  check('LOCAL_DELIVERY_METHODS lists ONLY real delivery methods (no sentinels)', setLiteral.length > 0 && !/no_method_available|'none'|'disabled'|'error'/.test(setLiteral), JSON.stringify(setLiteral.trim()))

  const ctxType = src('Tool.ts')
  // The method always resolves to the delivery-method string.
  check('ToolUseContext.sendOSNotification resolves to the method', /sendOSNotification\?:[\s\S]*?=> Promise<string>/.test(ctxType))

  const repl = src('screens', 'REPL.tsx')
  check('REPL.tsx RETURNS the sendNotification result (never voids it)', /sendOSNotification: \(opts[^)]*\) =>\s*[\s\S]{0,200}?sendNotification\(\{[^}]*\}, terminal\)/.test(repl) && !/sendOSNotification: \(opts[^)]*\) => \{\s*void sendNotification/.test(repl))
}

section('dist: the honest-delivery path ships')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    check('a real delivery method literal ships (iterm2_with_bell)', present('iterm2_with_bell'))
    check('the not-sent transport copy ships', present('no notification transport available'))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PUSH-NOTIFICATION HONEST-DELIVERY PROOFS PASS')
else console.log(`❌ ${failures} PUSH-NOTIFICATION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
