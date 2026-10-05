import React, { useState } from 'react'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderSync } from '../../src/ink/root.js'
import Box from '../../src/ink/components/Box.js'
import Text from '../../src/ink/components/Text.js'
import { AlternateScreen } from '../../src/ink/components/AlternateScreen.js'
import useInput from '../../src/ink/hooks/use-input.js'
import useApp from '../../src/ink/hooks/use-app.js'
import { readFrameWire, recordFrameTrace } from '../../src/ink/root/frame-trace.js'

export type SceneRun = { text: string; fg?: string | null; bg?: string | null; bold?: boolean; dim?: boolean; inv?: boolean }
export type Scene = { cols: number; rows: number; lines: SceneRun[][] }
const [sceneDir, timingPath] = process.argv.slice(2)
if (!sceneDir || !timingPath) throw new Error('scene needs its fixture directory and timing file')
const load = (name: string): Scene => JSON.parse(readFileSync(join(sceneDir, `${name}.json`), 'utf8'))
const scenes = { boot: load('boot'), chat: load('chat'), concourse: load('concourse') }
const composerRow = scenes.chat.lines.findIndex(line => line.map(run => run.text).join('').includes('Type a prompt'))
if (composerRow < 0) throw new Error('the captured chat has no composer row')
let rendered = { view: 'boot', draft: '' }

function Row({ runs }: { runs: SceneRun[] }) {
  return <Text wrap="truncate">{runs.map((run, key) => <Text key={key} color={(run.fg ?? undefined) as never} backgroundColor={(run.bg ?? undefined) as never} bold={run.bold && !run.dim || undefined} dim={run.dim && !run.bold || undefined} inverse={run.inv}>{run.text}</Text>)}</Text>
}
function Screen({ scene, draft }: { scene: Scene; draft: string }) {
  return <Box flexDirection="column">{scene.lines.map((runs, row) => {
    if (scene === scenes.chat && row === composerRow && draft.length > 0) {
      const text = runs.map(run => run.text).join('')
      const start = text.indexOf('Type a prompt')
      const end = text.indexOf('│', start)
      const stop = end < 0 ? text.length : end
      const body = text.slice(0, start) + draft.padEnd(stop - start, ' ').slice(0, stop - start) + text.slice(stop)
      return <Row key={row} runs={[{ ...runs[0]!, text: body }]} />
    }
    return <Row key={row} runs={runs} />
  })}</Box>
}
function App() {
  const [view, setView] = useState<keyof typeof scenes>('boot')
  const [draft, setDraft] = useState('')
  const { exit } = useApp()
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return exit()
    if (view === 'boot') { if (key.return) setView('chat'); return }
    if (key.shift && key.leftArrow) return setView('concourse')
    if (key.shift && key.rightArrow) return setView('chat')
    if (view !== 'chat') return
    if (key.backspace || key.delete) return setDraft(value => value.slice(0, -1))
    if (input && !key.ctrl && !key.meta) setDraft(value => value + input)
  })
  rendered = { view, draft }
  return <AlternateScreen mouseTracking={true}><Screen scene={scenes[view]} draft={draft} /></AlternateScreen>
}
const instance = renderSync(<App />, {
  exitOnCtrlC: false, patchConsole: false,
  onFrame(event) {
    recordFrameTrace({ durationMs: event.durationMs, phases: event.phases, flickers: event.flickers })
    appendFileSync(timingPath!, JSON.stringify({ atMs: performance.timeOrigin + performance.now(), ...rendered, ...event, wire: readFrameWire() }) + '\n')
  },
})
await instance.waitUntilExit()
process.exit(0)
