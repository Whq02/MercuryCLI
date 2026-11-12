import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = pinScratchHome('question-card-footer-key')
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.EDITOR = '/usr/bin/nano'
delete process.env.VISUAL
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const h = React.createElement
const { Box } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState } = await import('../../src/bootstrap/state.ts')
const { getKeybindingsPath } = await import('../../src/keybindings/loadUserBindings.ts')
const { QuestionView } = await import('../../src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx')
enableConfigs()

function writeBindings(tag: string, blocks: Array<{ context: string; bindings: Record<string, string | null> }> | null): void {
  const caseDir = join(HOME, `cwd-${tag}`)
  mkdirSync(caseDir, { recursive: true })
  setCwdState(caseDir)
  const path = getKeybindingsPath()
  if (blocks === null) {
    rmSync(path, { force: true })
    return
  }
  writeFileSync(path, JSON.stringify({ $schema: 'https://www.schemastore.org/mercury-keybindings.json', bindings: blocks }, null, 2))
}

const plainQuestion = {
  question: 'Which approach should we take?',
  header: 'Approach',
  multiSelect: false,
  options: [
    { label: 'Option A', description: 'Keep the existing structure' },
    { label: 'Option B', description: 'Split into two modules' },
  ],
}

const previewQuestion = {
  question: 'Which layout should we ship?',
  header: 'Layout',
  multiSelect: false,
  options: [
    { label: 'Compact', description: 'Single column', preview: 'Compact preview line' },
    { label: 'Wide', description: 'Two columns', preview: 'Wide preview line' },
  ],
}

async function mountQuestionCard(preview: boolean): Promise<Mounted> {
  function Host(): React.ReactNode {
    const [states, setStates] = React.useState<Record<string, { selectedValue?: string | string[]; textInputValue: string }>>({})
    const q = preview ? previewQuestion : plainQuestion
    return h(
      AppStateProvider,
      null,
      h(
        ThemeProvider,
        null,
        h(
          KeybindingSetup,
          null,
          h(
            Box,
            { width: 110, height: 28, flexDirection: 'column' },
            h(QuestionView, {
              question: q as never,
              questions: [q as never],
              currentQuestionIndex: 0,
              answers: {},
              questionStates: states as never,
              onUpdateQuestionState: (text, updates) => {
                setStates(prev => ({ ...prev, [text]: { ...prev[text], textInputValue: prev[text]?.textInputValue ?? '', ...updates } }))
              },
              onAnswer: () => {},
              onTextInputFocus: () => {},
              onCancel: () => {},
              onSubmit: () => {},
              onRespondToModel: () => {},
            }),
          ),
        ),
      ),
    )
  }
  const m = await mountOffscreen(h(Host), 110, 28)
  await waitFor(() => m.screen().includes('Esc to cancel'), 5000)
  if (preview) {
    m.push('n')
    await waitFor(() => m.screen().includes('Add notes on this design'), 4000)
  } else {
    m.push(KEY.down)
    await settle(80)
    m.push(KEY.down)
    await waitFor(() => m.screen().includes('Enter to answer with your text'), 4000)
  }
  await settle(100)
  return m
}

const cases: Array<{
  tag: string
  blocks: Array<{ context: string; bindings: Record<string, string | null> }> | null
  expected: string | null
}> = [
  { tag: 'default', blocks: null, expected: 'ctrl+g to edit in Nano' },
  {
    tag: 'rebound-confirmation',
    blocks: [{ context: 'Confirmation', bindings: { 'ctrl+g': null, 'ctrl+o': 'chat:externalEditor' } }],
    expected: 'ctrl+o to edit in Nano',
  },
  {
    tag: 'unbound-confirmation-chat-fallback',
    blocks: [{ context: 'Confirmation', bindings: { 'ctrl+g': null } }],
    expected: 'ctrl+x ctrl+e to edit in Nano',
  },
  {
    tag: 'unbound-both',
    blocks: [
      { context: 'Confirmation', bindings: { 'ctrl+g': null } },
      { context: 'Chat', bindings: { 'ctrl+x ctrl+e': null } },
    ],
    expected: null,
  },
]

for (const { tag, blocks, expected } of cases) {
  writeBindings(tag, blocks)
  for (const [kind, preview] of [['question', false], ['preview', true]] as const) {
    const view = await mountQuestionCard(preview)
    try {
      const lines = view.lines()
      if (frameDir) writeFileSync(join(frameDir, `${kind}-${tag}.txt`), lines.join('\n') + '\n')
      const footer = lines.find(line => line.includes('Esc to cancel')) ?? ''
      if (expected !== null) {
        check(
          `${kind} (${tag}): footer names bound key "${expected}"`,
          footer.includes(`· ${expected} · Esc to cancel`),
          footer,
        )
      } else {
        check(
          `${kind} (${tag}): footer omits editor hint when unbound in both contexts`,
          footer.includes('Esc to cancel') && !footer.includes('to edit in'),
          footer,
        )
      }
    } finally {
      view.unmount()
    }
  }
}

console.log(`question-card-footer-key: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures ? 1 : 0)
