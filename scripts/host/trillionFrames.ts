import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

export async function trillionFrames(question: LlmHostQuestion, check: (name: string, truth: unknown) => void, output?: string) {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  for (const [cols, rows] of [[120, 44], [80, 24]] as const) {
    const road: LlmHostRoad = async ask => { await ask(question); return { ok: false, words: 'cancelled' } }
    popup.openSettingsPopup(llmHostPopupRequest(road))
    const m = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: cols, height: rows }, React.createElement(SettingsPopupSlot)))), cols, rows)
    try {
      assert.ok(await waitFor(() => m.screen().includes('Confirm the hourly price'), 5000), m.screen())
      const screen = m.screen()
      if (output) {
        mkdirSync(output, { recursive: true })
        const stem = join(output, 'price-' + cols)
        writeFileSync(stem + '.txt', screen)
        const grid = m.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => { const s = m.styleAt(x, y); return { c, fg: s?.fg ?? 'default', bg: s?.bg ?? 'default', bold: s?.bold ?? false } }))
        writeFileSync(stem + '.json', JSON.stringify({ grid, cols, rows }))
        await gridToPng(stem + '.json', stem + '.png')
      }
      const first = screen.replace(/[│\s]+/g, ' ')
      check(cols + '-column frame shows node count, total rate, disk and weight size', ['2 nodes × 8× B200', '$127.84/hr', '2 × 2 TB disk', 'weights 1.56 TB'].every(word => first.includes(word)))
      check(cols + '-column first frame retains the cluster billing warning, confirmation and cancel hint', ['a cluster has no Stop', 'bills until Terminate', 'above this catalogue rate', 'Confirm $127.84/hr', 'Cancel', 'esc'].every(word => first.includes(word)) && !first.includes('stopped pod'))
      let details = screen
      for (;;) {
        const marker = /Details (\d+)–(\d+) of (\d+)/.exec(m.screen())
        if (!marker || marker[2] === marker[3]) break
        const before = m.screen()
        m.push('\x1b[6~')
        assert.ok(await waitFor(() => m.screen() !== before, 5000), 'the remaining rental details can be paged')
        details += '\n' + m.screen()
        check(cols + '-column paged details keep both rental choices visible', m.screen().includes('Confirm $127.84/hr') && m.screen().includes('Cancel'))
        if (output) writeFileSync(join(output, 'price-' + cols + '-paged.txt'), m.screen())
      }
      const all = details.replace(/[│\s]+/g, ' ')
      check(cols + '-column details show download assumption and per-token alternative', ['30–60 min', '0.5–1 GB/s', 'per token by Kimi', 'https://platform.kimi.ai', 'only when kept busy'].every(word => all.includes(word)))
      check(cols + '-column frame stays inside its width without render faults', m.lines().every(line => stringWidth(line) <= cols) && !screen.includes('RENDER ERROR'))
    } finally { popup.closeSettingsPopup(); m.unmount() }
    const { LlmHostDialog } = await import('../../src/components/LlmHostDialog.tsx')
    const renderOther = async (lines?: string[]) => {
      const road: LlmHostRoad = async ask => { await ask({ step: 'models', title: 'Unchanged model picker', found: 'fixture', willRun: 'nothing paid', rows: [{ value: 'a', label: 'fixture-model' }], ...(lines ? { lines } : {}) }); return { ok: false, words: 'cancelled' } }
      const view = await mountOffscreen(React.createElement(ThemeProvider, {}, React.createElement(LlmHostDialog, { width: cols, rowBudget: rows, road })), cols, rows)
      try { assert.ok(await waitFor(() => view.screen().includes('fixture-model'), 5000)); return view.screen() } finally { view.unmount() }
    }
    check(cols + '-column non-confirmation frame is byte-identical with optional disclosure data', await renderOther() === await renderOther(['this belongs only on rent-confirm']))
  }
}
