import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../src/types/message.js'

export const thought = 'private reasoning must never leave this record'
export const longResult = 'R'.repeat(10_000)
export const at = (n: number): string => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`
export const fixtureId = '00000000-0000-4000-8000-000000000001'

export async function exportFixture(extra = '') {
  const scratch = mkdtempSync(join(tmpdir(), 'export-proof-'))
  process.env.MERCURY_CONFIG_DIR = scratch
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.js')
  for (const key of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key]
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
  const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
  const base = noSessionConnector()
  setFocusedSessionConnector({
    ...base,
    sessionId: () => fixtureId,
    workspace: () => ({ ...base.workspace(), cwd: scratch }),
  })
  const user = (n: number, content: unknown) => ({
    type: 'user', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    timestamp: at(n), message: { role: 'user', content },
  })
  const assistant = (n: number, content: unknown[]) => ({
    type: 'assistant', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    timestamp: at(n), requestId: undefined,
    message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'fixture-model', content,
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })
  const messages = [
    user(1, `Please check café. ${extra}`.trim()),
    assistant(2, [
      { type: 'thinking', thinking: thought, signature: 'private-signature' },
      { type: 'redacted_thinking', data: 'private-reasoning-ciphertext' },
      { type: 'text', text: 'I will read both files.', citations: null },
      { type: 'tool_use', id: 'call_one', name: 'Read', input: { file_path: `first.txt ${extra}`.trim() } },
      { type: 'tool_use', id: 'call_two', name: 'Read', input: { file_path: 'second.txt' } },
    ]),
    user(3, [
      { type: 'tool_result', tool_use_id: 'call_two', content: longResult },
      { type: 'tool_result', tool_use_id: 'call_one', content: [{ type: 'text', text: `First file. ${extra}`.trim() }] },
    ]),
    assistant(4, [{ type: 'text', text: 'Both files checked.', citations: null }]),
  ] as Message[]
  const { call } = await import('../../src/commands/export/export.js')
  return {
    scratch, messages,
    async write(name: string) {
      let receipt = ''
      const view = await call(message => { receipt = message ?? '' }, { messages, options: { tools: [] } } as never, name)
      return { receipt, view }
    },
    close() {
      releaseFocusedSessionConnector()
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}
