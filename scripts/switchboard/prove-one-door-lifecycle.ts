#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'one-door-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}


console.log('C — close all chats ⇒ the boot menu (rule 5)')
{

  {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: joinPath } = await import('node:path')
    process.env.MERCURY_CONFIG_DIR = mkdtempSync(joinPath(tmpdir(), 'one-door-swap-'))
    const { enableConfigs } = await import('../../src/platform/settings/config.js')
    enableConfigs()
    const { evaluateConcourseAdmission } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
    const seatA = { workspaceId: '/w/alpha', isolation: 'shared' as const }
    const seatB = { workspaceId: '/w/beta', isolation: 'shared' as const }
    const birth = { workspaceId: '/w/alpha', isolation: 'shared' as const }
    const full = evaluateConcourseAdmission([seatA, seatB], birth, 2)
    check('C3s RED CONTROL: a full 2-seat world refuses a plain birth on the capacity code (the sighting)', full.admit === false && (full as { code?: string }).code === 'runtime-ceiling', '', 'evaluateConcourseAdmission in src/daemon/concourse-workers/admission.ts must refuse a plain birth with code runtime-ceiling when every seat of the ceiling is held')
    const swapped = evaluateConcourseAdmission([seatB], birth, 2)
    check('C3s the SAME world minus the vacating seat ADMITS — the birth rides the seat /clear vacates', swapped.admit === true, '', 'evaluateConcourseAdmission in src/daemon/concourse-workers/admission.ts must admit a birth in the workspace of the vacating seat when that seat leaves')
  }
}

console.log('F — the two switches (the amendment)')
{
  const { normalizeBankedFlagSpellings, applyBankedFlagSpellings, BANKED_FLAG_SPELLINGS } = await import('../../src/platform/substrate/argvSpellings.ts')
  check('F1 the banked spellings admit as the estate\'s forms', JSON.stringify(normalizeBankedFlagSpellings(['-chat', '-concourse-off', '-concourse-on'])) === JSON.stringify(['--chat', '--concourse-off', '--concourse-on']), '', 'fix normalizeBankedFlagSpellings and BANKED_FLAG_SPELLINGS in src/platform/substrate/argvSpellings.ts')
  check('F1 exact tokens only: -c stays --continue\'s short, -chatty and --chat are untouched', JSON.stringify(normalizeBankedFlagSpellings(['-c', '-chatty', '--chat', 'words'])) === JSON.stringify(['-c', '-chatty', '--chat', 'words']), '', 'normalizeBankedFlagSpellings in src/platform/substrate/argvSpellings.ts must rewrite exact banked tokens only')
  check('F1 the -- sentinel ends the rewrite (an operand spelled -chat after it is the operand)', JSON.stringify(normalizeBankedFlagSpellings(['-chat', '--', '-chat'])) === JSON.stringify(['--chat', '--', '-chat']), '', 'normalizeBankedFlagSpellings in src/platform/substrate/argvSpellings.ts must stop rewriting at the -- sentinel')
  const argv = ['node', 'mercury.mjs', '-chat', '--title', 'x']
  applyBankedFlagSpellings(argv)
  check('F1 the in-place apply keeps the binary and the script and rewrites the rest', JSON.stringify(argv) === JSON.stringify(['node', 'mercury.mjs', '--chat', '--title', 'x']), '', 'applyBankedFlagSpellings in src/platform/substrate/argvSpellings.ts must rewrite argv in place after the binary and the script')
  check('F1 the table names exactly the three banked spellings', Object.keys(BANKED_FLAG_SPELLINGS).sort().join(',') === '-chat,-concourse-off,-concourse-on', '', 'BANKED_FLAG_SPELLINGS in src/platform/substrate/argvSpellings.ts must hold exactly these three keys')
  const { builtHelp } = await import('../lib/builtProduct.ts')
  const rootHelp = builtHelp()
  check('F2 the three options exist in the estate\'s grammar with their help naming the banked spellings', rootHelp.includes(' --chat ') && rootHelp.includes(' --concourse-off ') && rootHelp.includes(' --concourse-on ') && rootHelp.includes('`-chat` is the same switch') && rootHelp.includes('`-concourse-off` is the same switch'), '', 'the root options in src/boot/main/rootOptions.ts must declare --chat, --concourse-off and --concourse-on with help naming -chat and -concourse-off as the same switch; the help is read from the built bundle, so rebuild if the source already says so')
  const { enableConfigs } = await import('../../src/platform/settings/config.js')
  enableConfigs()
  const { concourseEnabled, setConcourseEnabled } = await import('../../src/screen/concourse-model/concourseEnabled.ts')
  check('F3 DEFAULT ON: a fresh home boots WITH the concourse', concourseEnabled() === true, '', 'concourseEnabled in src/screen/concourse-model/concourseEnabled.ts must return true when the config field is unset')
  setConcourseEnabled(false)
  check('F3 --concourse-off sets the field off', concourseEnabled() === false, '', 'setConcourseEnabled in src/screen/concourse-model/concourseEnabled.ts must save concourseEnabled false')
  const configPath = join(process.env.MERCURY_CONFIG_DIR!, '.mercury.json')
  const bytes = readFileSync(configPath, 'utf8')
  check('F3 the field is PERSISTED under its registered name', /"concourseEnabled"\s*:\s*false/.test(bytes), '', 'setConcourseEnabled in src/screen/concourse-model/concourseEnabled.ts must persist the concourseEnabled field to the config file')
  const child = Bun.spawnSync({
    cmd: [process.execPath, '-e', "const m = await import('./src/screen/concourse-model/concourseEnabled.ts'); const c = await import('./src/platform/settings/config.js'); c.enableConfigs(); console.log(String(m.concourseEnabled()))"],
    cwd: process.cwd(),
    env: { ...process.env, MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR! },
  })
  check('F3 the OFF state survives a fresh process (re-read from disk — the restart half)', child.stdout.toString().trim() === 'false', child.stderr.toString().slice(-200), 'concourseEnabled in src/screen/concourse-model/concourseEnabled.ts must read the saved field from disk in a fresh process')
  setConcourseEnabled(true)
  check('F3 the symmetric re-enable turns it back on (off is never a one-way door)', concourseEnabled() === true, '', 'setConcourseEnabled(true) in src/screen/concourse-model/concourseEnabled.ts must turn the concourse back on')
  const before = readFileSync(configPath, 'utf8')
  concourseEnabled()
  concourseEnabled()
  check('F3 SET, never heal-repainted: reads write nothing back', readFileSync(configPath, 'utf8') === before, '', 'concourseEnabled in src/screen/concourse-model/concourseEnabled.ts must only read and never save the config')
}

console.log('C2 — the chat that fronts a resting slot, read off the mounted session part of the chat screen')
{
  const { openSessionPart } = await import('../ui/chatScenarios.ts')
  const session = await openSessionPart('one-door-session', { keepHome: true })
  const kind = (): string => session.route.currentSurfaceRoute().kind
  const beat = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 450))
  const dialog = { jsx: null, shouldHideComposer: false, isLocalJSXCommand: true } as never
  process.env.MERCURY_FULLSCREEN = '0'
  await session.focus(null)
  await beat()
  const inline = kind()
  process.env.MERCURY_FULLSCREEN = '1'
  await session.plant({ localJsx: true })
  await session.plant({ localJsx: false, toolJSXRef: { current: dialog } })
  await beat()
  const underDialog = kind()
  await session.plant({ localJsx: true })
  await session.plant({ localJsx: false, toolJSXRef: { current: null } })
  for (let turn = 0; turn < 75 && kind() === 'repl'; turn++) await new Promise(resolve => setTimeout(resolve, 40))
  const resting = kind()
  await session.close()
  check('C2 the root Chat yields whenever it would front a resting slot, handing the frame to the router\'s one absent-chat landing (settleAbsentChat, never a return token onto the empty chat)', resting === 'boot-settings' && session.route.activeReturnToken() === null, `${resting} · return token ${JSON.stringify(session.route.activeReturnToken())}`, 'the root Chat must call settleAbsentChat (src/screen/routes/surfaceRoute.ts) from src/screen/chat/useChatSession.ts when it fronts a resting slot')
  check('C2 the yield settles one beat and re-reads every fact at fire time (a mounting dialog is never buried)', underDialog === 'repl', underDialog, 'the yield in src/screen/chat/useChatSession.ts must re-read the dialog state when it fires')
  check('C2 an inline boot keeps its Chat (CB-10: no frame for the face)', inline === 'repl', inline, 'the yield in src/screen/chat/useChatSession.ts must not fire for an inline boot')
}

removeScratch(SCRATCH)
console.log(failures === 0 ? '\nprove-one-door-lifecycle: ALL LAWS HOLD' : `\nprove-one-door-lifecycle: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
