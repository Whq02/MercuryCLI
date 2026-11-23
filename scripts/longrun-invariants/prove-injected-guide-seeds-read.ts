#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('\n=== harness-known files need no redundant Read (AVS MEMORY.md) ===')
{
  process.env.NODE_ENV = 'test'
  const fixtureProject = mkdtempSync(join(tmpdir(), 'vigil-seed-project-'))
  const nativeGuide = join(fixtureProject, 'MERCURY.md')
  writeFileSync(nativeGuide, '# fixture guide\n\nseeding-law fixture content.\n')
  const { setOriginalCwd, setSessionTrustAccepted } = await import('../../src/boot/process-state/processState.js')
  const restoreCwd = process.cwd()
  setOriginalCwd(fixtureProject)
  setSessionTrustAccepted(true)
  process.chdir(fixtureProject)
  const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.js')
  const { seedFileKnowledgeFromInjectedInstructions } = await import('../../src/sessions/instructions/instructionFiles.js')
  const cache = createFileStateCacheWithSizeLimit(1000)
  await seedFileKnowledgeFromInjectedInstructions(cache)
  process.chdir(restoreCwd)
  setOriginalCwd(restoreCwd)
  const guide = nativeGuide
  const seeded = cache.get(guide)
  check('the injected root guide is seeded into readFileState', seeded !== undefined, 'seedFileKnowledgeFromInjectedInstructions in src/sessions/instructions/instructionFiles.ts set no entry for the fixture MERCURY.md; check that getInstructionFiles and filterInjectedInstructionFiles still return it with content')
  check('…with the CURRENT disk bytes (honest knowledge, not a guess)', seeded?.content === readFileSync(guide, 'utf8'), 'the seeded content differs from the file on disk; fix the content stored by seedFileKnowledgeFromInjectedInstructions in src/sessions/instructions/instructionFiles.ts')
  check('…and a real mtime stamp', typeof seeded?.timestamp === 'number' && seeded.timestamp > 0, 'the seeded entry has no positive timestamp; fix the timestamp set from statSync mtimeMs in seedFileKnowledgeFromInjectedInstructions in src/sessions/instructions/instructionFiles.ts')

  const { getDefaultAppState } = await import('../../src/screen/app-state/AppState.js')
  const appState = getDefaultAppState()
  const { FileWriteTool } = await import('../../src/tools/write/WriteTool.js')
  const verdict = await FileWriteTool.validateInput(
    { file_path: guide, content: 'x' },
    { readFileState: cache, getAppState: () => appState } as never,
  )
  check('FileWriteTool.validate PASSES on the seeded file (no forced Read)', verdict.result === true, `${JSON.stringify(verdict)} (FileWriteTool.validateInput in src/tools/write/WriteTool.ts must accept a file whose content the readFileState cache already holds from seedFileKnowledgeFromInjectedInstructions)`)
  const scratch = mkdtempSync(join(tmpdir(), 'vigil-blind-write-'))
  const blindPath = join(scratch, 'existing.txt')
  writeFileSync(blindPath, 'original\n')
  const empty = createFileStateCacheWithSizeLimit(10)
  const blindCtx = {
    readFileState: empty,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => appState,
  } as never
  const blind = await FileWriteTool.validateInput({ file_path: blindPath, content: 'changed\n' }, blindCtx)
  check('validateInput is content-free — the gate moved to call', blind.result === true, 'FileWriteTool.validateInput in src/tools/write/WriteTool.ts must not read file content or refuse an unread existing file; the prior-read gate belongs in call')
  let refusal = ''
  try {
    await (FileWriteTool as { call: Function }).call({ file_path: blindPath, content: 'changed\n' }, blindCtx, null, {
      uuid: '00000000-0000-0000-0000-0000000000b1',
      message: { id: 'msg_vigil_blind' },
    })
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err)
  }
  check('an UNSEEDED existing file still refuses a blind CHANGING Write at call() (the gate stands)', /prior read of the current content is required/.test(refusal), `${refusal || 'settled?!'} (FileWriteTool.call in src/tools/write/WriteTool.ts must refuse a changing write to an existing file absent from readFileState; the refusal text is built in src/tools/edit/otherSession.ts)`)
  check('nothing was written on the refusal', readFileSync(blindPath, 'utf8') === 'original\n', 'the file on disk changed although FileWriteTool.call should have refused the blind write; check the prior-read gate in src/tools/write/WriteTool.ts')
}

console.log(`\n${failures === 0 ? '✅ ALL PASS — harness knowledge is shared' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
