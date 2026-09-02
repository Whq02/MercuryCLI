#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-brief-away-scope.ts — brief is AWAY-SCOPED (operator
//  ruling, the Fareed friction): an interactive desktop session
//  replies as normal streaming text; the SendUserMessage courier activates
//  only for away contexts or explicit opt-ins.
//    · interactive default: OFF (the assistant-family default no longer
//      leaks the courier register into desktop chats);
//    · explicit opt-ins: /brief (userMsgOptIn) · MERCURY_BRIEF=1 ·
//      MERCURY_BRIEF=1 · an explicit setAssistantSessionActive(true) session flip;
//    · MERCURY_BRIEF=0 kills everywhere;
//    · the daemon's cron/dispatch children carry MERCURY_BRIEF=1 (the
//      genuine away context gets the courier + notifications);
//    · the assistant-family surfaces (Monitor steering) STILL read the product
//      default — only brief moved to the explicit session marker.
// ============================================================================

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const saved = {
  brief: process.env.MERCURY_BRIEF,
  hermesBrief: process.env.MERCURY_BRIEF,
}
delete process.env.MERCURY_BRIEF
delete process.env.MERCURY_BRIEF

const { isBriefEnabled } = await import('../../src/tools/BriefTool/BriefTool.ts')
const state = await import('../../src/bootstrap/state.ts')

console.log('── interactive desktop: normal replies ──')
check('brief default is OFF in an interactive session', isBriefEnabled() === false)
check(
  'the assistant FAMILY stays default-on (Monitor steering unbroken)',
  state.isAssistantFamilyAvailable() === true,
)
check('the explicit session marker is honest (unset)', state.isAssistantSessionActive() === false)

console.log('── explicit opt-ins activate the courier ──')
process.env.MERCURY_BRIEF = '1'
check('MERCURY_BRIEF=1 activates', isBriefEnabled() === true)
delete process.env.MERCURY_BRIEF
process.env.MERCURY_BRIEF = '1'
check('MERCURY_BRIEF=1 activates', isBriefEnabled() === true)
delete process.env.MERCURY_BRIEF
state.setUserMsgOptIn(true)
check('/brief (userMsgOptIn) activates', isBriefEnabled() === true)
state.setUserMsgOptIn(false)
state.setAssistantSessionActive(true)
check('an explicit assistant session flip activates', isBriefEnabled() === true)
state.setAssistantSessionActive(false)

console.log('── the kill ──')
process.env.MERCURY_BRIEF = '0'
state.setUserMsgOptIn(true)
check('MERCURY_BRIEF=0 kills even over an explicit opt-in', isBriefEnabled() === false)
state.setUserMsgOptIn(false)
delete process.env.MERCURY_BRIEF

console.log('── the daemon away grant ──')
const { readFileSync } = await import('node:fs')
const headless = readFileSync('src/daemon/headlessRun.ts', 'utf8')
check(
  "cron/dispatch children carry MERCURY_BRIEF ??= '1' (the away context gets the courier)",
  /MERCURY_BRIEF \?\?= '1'/.test(headless),
)
const briefSrc = readFileSync('src/tools/BriefTool/BriefTool.ts', 'utf8')
check(
  'activation reads the EXPLICIT session marker, never the fork default',
  briefSrc.includes('isAssistantSessionActive()') &&
    !/return \(isAssistantFamilyAvailable\(\) \|\| getUserMsgOptIn\(\)\) && isBriefEntitled\(\)/.test(briefSrc),
)
check('scribe CHATROOM keeps its chat line', /scribeChatroomEnabled\(\)\)\s*\n\s*return awayOrOptIn/.test(briefSrc))

// restore
if (saved.brief === undefined) delete process.env.MERCURY_BRIEF
else process.env.MERCURY_BRIEF = saved.brief
if (saved.hermesBrief === undefined) delete process.env.MERCURY_BRIEF
else process.env.MERCURY_BRIEF = saved.hermesBrief

console.log(failures === 0 ? 'BRIEF AWAY-SCOPE: ALL GREEN' : `BRIEF AWAY-SCOPE: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
