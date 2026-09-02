// ============================================================================
//  prove-mercury-loyal — the harness is strictly Mercury-loyal in operator-
//  facing UI: no foreign-product referral/upsell
//  adverts, no Hermes-legacy surface naming.
//
//  #76: every guest-passes upsell emitter is stamp-gated (the spinner tip, the
//  boot-logo band, the shouldShow predicate). The /passes command itself
//  stays (deliberate visit ≠ an advert).
//  #77: the rebrand left ~15 operator-facing 'Hermes' literals (dialogs,
//  empty states, tips, nameplates). Swept to Mercury; this proof pins the
//  swept files clean so a future port can't silently reintroduce them.
//  (HERMES_ env gates / historical the build stamp vocabulary are
//  INTERNAL seams — the rebrand decision keeps them; only rendered text is
//  in scope, so the scan targets string/JSX literals in the swept files.)
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}
const read = (p: string): string => readFileSync(join(root, p), 'utf-8')

// ---- #76: upsell suppressions -----------------------------------------------
// the gates fold to UNCONDITIONAL
// suppression. /passes depromotion: the whole
// referral surface is DELETED — strictly stronger than gated-off. Pin the
// absence (the file-absence ratchets pin the files; this pins the emitters).
const tips = read('src/services/tips/tipRegistry.ts')
check(
  !tips.includes("id: 'guest-passes'"),
  "the guest-passes spinner tip is DELETED (was isRelevant:false; /passes depromotion)",
)
check(
  !/['"`]\/passes['"`]/.test(tips),
  'no tip advertises the removed /passes command (quoted/rendered occurrences)',
)
// /theme removal: the retired theme pane is absent —
// /appearance is the ONE canonical picker. A tip steering to /theme would
// advertise a removed command (the exact /passes class).
check(
  !/['"`\s]\/theme\b/.test(tips),
  'no tip advertises the removed /theme command (/appearance is canonical)',
)
check(
  tips.includes("id: 'appearance-command'"),
  'the appearance tip exists and steers to the canonical /appearance center',
)
// /doctor → /health: the slash roster owns /health; a tip
// steering to /doctor would advertise a name the roster does not carry.
check(
  !/['"`\s]\/doctor\b/.test(tips),
  'no tip advertises the renamed /doctor command (/health is canonical)',
)

// ---- #77: swept files carry no rendered 'Hermes' ---------------------------
// Rendered-text scan: a word-boundary 'Hermes' inside a quoted string or JSX
// text. Identifier names (MercuryFrame, the build stamp, HERMES_) don't
// match the boundary-word-with-space shapes below.
const SWEPT = [
  'src/components/agents/studio/AgentStudio.tsx',
  'src/components/InterruptedByUser.tsx',
  'src/components/ModelPicker.tsx',
  'src/components/IdeOnboardingDialog.tsx',
  'src/components/LogSelector.tsx',
  'src/components/Spinner.tsx',
  'src/components/Settings/Config.tsx',
  'src/components/messages/UserTeammateMessage.tsx',
  // consent-core sweep: the permission hot path — "tell Hermes
  // what to do next/differently" ×13 sites + the AutoDefaultDialogs body.
  'src/components/permissions/PermissionPrompt.tsx',
  // SandboxPermissionRequest retired with the stranded-estate walk — the
  // worker sandbox ask rides the ONE ask road now (structuredIO canUseTool →
  // the daemon's permission asks → the consent card, itself on this list).
  'src/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx',
  'src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx',
  'src/components/permissions/PowerShellPermissionRequest/powershellToolUseOptions.tsx',
  'src/components/permissions/FilePermissionDialog/permissionOptions.tsx',
  'src/tools/WorkflowTool/WorkflowPermissionRequest.tsx',
  // new-agent-creation left the estate at (the wizard died with the
  // Agent Studio landing); the studio editor carries the swept-copy duty.
  'src/components/agents/studio/StudioEditor.tsx',
  'src/components/ThemePicker.tsx',
]
// The AutoDefaultDialogs body must speak the Mercury form (the mode is named Flow).
check(
  read('src/components/AutoDefaultDialogs.tsx').includes('Flow lets Mercury handle permission prompts'),
  'AutoDefaultDialogs body says Mercury (was: Claude)',
)
const RENDERED_HERMES = /["'`>][^"'`<\n]*\bHermes\b[^"'`<\n]*["'`<]/
for (const p of SWEPT) {
  const src = read(p)
  const hit = RENDERED_HERMES.exec(src)
  check(!hit, `${p.split('/').pop()} renders no 'Hermes' text${hit ? ` (found: ${hit[0].slice(0, 60)})` : ''}`)
}
console.log(failures === 0 ? '✅ mercury loyal GREEN' : `❌ mercury loyal RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
