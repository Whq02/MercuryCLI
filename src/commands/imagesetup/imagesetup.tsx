import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { RawAnsi } from '../../ink/components/RawAnsi.js'
import { useSettingsPopupFrame } from '../../components/Settings/Settings.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from '../../components/mercury-ui/useOpenEventGate.js'
import { imageToCells } from '../../services/visual/imageDisplay.js'
import { gibWords } from '../../services/localServer/localServerMemory.js'
import { mediaPullPlan, mediaProgressWords, mediaSizeWords, pullMedia, readMediaSnapshot, runMediaSetup, MediaSetupPaused, type MediaPullPlan, type MediaSnapshot } from '../../services/media/setup.js'
import { saveMediaSettings, readMediaSettings } from '../../services/media/settings.js'
import { generateMediaTestImage, type MediaTestImage } from '../../services/media/generation.js'
import { openSettingsPopup, closeSettingsPopup, type SettingsPopupGeometry, type SettingsPopupRequest } from '../../utils/cockpit/settingsPopup.js'
import { stripTerminalControls } from '../../utils/stringUtils.js'
import { reloadExtensions, noteReloaded } from '../../extensions/boot.js'
import { extensionsStateFrom } from '../../hooks/useExtensions.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'

export const IMAGE_SETUP_HINT = '↑↓ select · p pull · d default · t test image · esc closes'
export type ImageSetupIo = {
  read: () => Promise<MediaSnapshot>
  pull: typeof runMediaSetup
  setDefault: (kind: 'image' | 'video', model: string) => Promise<void>
  test: (model: string, controller: AbortController, onStart?: () => void) => Promise<MediaTestImage>
}

export function imageSetupIo(context: LocalJSXCommandContext): ImageSetupIo {
  return {
    read: () => readMediaSnapshot(),
    pull: async (args, onProgress, signal, settings) => {
      await runMediaSetup(args, onProgress, signal, settings)
      if (args[0] !== 'pull-model' || readMediaSettings().enabled) return
      await saveMediaSettings({ enabled: true })
      const pending = reloadExtensions({ onServersChanged: () => context.setAppState(prev => ({ ...prev, mcp: { ...prev.mcp, extensionReconnectKey: prev.mcp.extensionReconnectKey + 1 } })) })
      noteReloaded(pending)
      const result = await pending
      context.setAppState(prev => ({ ...prev, extensions: extensionsStateFrom(result.set, false, null) }))
    },
    setDefault: (kind, model) => saveMediaSettings({ [kind === 'image' ? 'imageModel' : 'videoModel']: model }),
    test: (model, controller, onStart) => generateMediaTestImage(model, context, controller, onStart),
  }
}

export function ImageSetupBody({ geometry, io, preview, initialError }: { geometry: SettingsPopupGeometry; io: ImageSetupIo; preview?: MediaTestImage; initialError?: string }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  const tokens = useMercuryTokens()
  const pastOpen = useOpenEventGate()
  const [snapshot, setSnapshot] = React.useState<MediaSnapshot | null>(null)
  const [error, setError] = React.useState(initialError ?? '')
  const [cursor, setCursor] = React.useState(0)
  const [busy, setBusy] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [ask, setAsk] = React.useState<MediaPullPlan | null>(null)
  const [image, setImage] = React.useState<MediaTestImage | undefined>(preview)
  const [cells, setCells] = React.useState<string>('')
  const consent = React.useRef<((yes: boolean) => void) | null>(null)
  const operation = React.useRef<AbortController | null>(null)
  const alive = React.useRef(true)
  const reload = React.useCallback(async () => {
    const next = await io.read()
    if (alive.current) setSnapshot(next)
  }, [io])
  React.useEffect(() => {
    alive.current = true
    void reload().catch(error => { if (alive.current) setError(String(error instanceof Error ? error.message : error)) })
    return () => { alive.current = false; operation.current?.abort(); consent.current?.(false) }
  }, [reload])
  React.useLayoutEffect(() => {
    frame.setOwnsEscape(true)
    frame.setLine(snapshot ? `${snapshot.root} · ${gibWords(snapshot.totalMemoryBytes)} memory · ${mediaSizeWords(snapshot.freeBytes)} free` : 'Local images and video')
    return () => frame.setOwnsEscape(false)
  }, [snapshot, frame.setLine, frame.setOwnsEscape])
  React.useEffect(() => {
    if (!image) { setCells(''); return }
    let active = true
    void imageToCells(image.png, Math.max(1, geometry.inner - 2), Math.max(1, geometry.rowBudget - 3)).then(value => { if (active) setCells(value) }, error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [image, geometry.inner, geometry.rowBudget])

  const perform = (label: string, run: (signal: AbortSignal) => Promise<void>): void => {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(label)
    setError('')
    setNotice('')
    void run(controller.signal).then(reload).catch(error => {
      if (!alive.current) return
      if (error instanceof MediaSetupPaused) {
        setNotice(error.message)
        void reload().catch(error => { if (alive.current) setError(String(error)) })
      } else setError(String(error instanceof Error ? error.message : error))
    }).finally(() => {
      operation.current = null
      if (alive.current) { setBusy(''); setAsk(null) }
    })
  }
  const row = snapshot?.rows[cursor - 1]
  useInput((input, key, event) => {
    event.stopImmediatePropagation()
    if (key.escape) {
      if (ask) { consent.current?.(false); consent.current = null; setAsk(null); return }
      if (operation.current) { operation.current.abort(); return }
      if (image) { setImage(undefined); return }
      frame.close()
      return
    }
    if (ask) {
      if (input.toLowerCase() === 'y' && pastOpen()) { consent.current?.(true); consent.current = null; setAsk(null) }
      else if (input.toLowerCase() === 'n') { consent.current?.(false); consent.current = null; setAsk(null) }
      return
    }
    if (!snapshot || busy || image) return
    if (key.upArrow) { setCursor(Math.max(0, cursor - 1)); return }
    if (key.downArrow) { setCursor(Math.min(snapshot.rows.length, cursor + 1)); return }
    if (!pastOpen()) return
    if (input === 'p') {
      try {
        const plan = mediaPullPlan(snapshot, row?.model.id)
        perform(plan.title, async signal => {
          await pullMedia(plan, plan => new Promise(resolve => { consent.current = resolve; setAsk(plan) }), (args, progress, signal) => io.pull(args, progress, signal, { ...readMediaSettings(), root: plan.root }), progress => { if (alive.current) setBusy(mediaProgressWords(progress) || plan.title) }, signal)
        })
      } catch (error) { setError(String(error instanceof Error ? error.message : error)) }
    } else if (input === 'd' && row) {
      perform(row.model.id, () => io.setDefault(row.model.kind, row.model.id))
    } else if (input === 't' && row?.model.kind === 'image') {
      if (!readMediaSettings().enabled) { setError('Turn on Local media in /config.'); return }
      if (!row.installed || !snapshot.runtimeInstalled) { setError('Select the runtime and model, then press p to pull.'); return }
      closeSettingsPopup()
      const controller = new AbortController()
      void io.test(row.model.id, controller, () => openSettingsPopup({ view: 'imagesetup', width: 80, rows: 8, line: 'Local test image', hint: 'esc cancels', bodyOwnsEscape: true, body: () => <ImageTestProgress model={row.model.id} controller={controller} /> })).then(
        preview => openSettingsPopup(imageSetupPopupRequest(io, preview)),
        error => openSettingsPopup(imageSetupPopupRequest(io, undefined, String(error instanceof Error ? error.message : error))),
      )
    }
  })

  if (image) return <Box flexDirection="column"><Text wrap="truncate-end">{image.path}</Text>{cells ? <RawAnsi lines={cells.split('\n')} width={geometry.inner} /> : null}{error ? <Text color={tokens.failure}>{stripTerminalControls(error)}</Text> : null}<Text dimColor>esc back</Text></Box>
  if (ask) return <Box flexDirection="column"><Text bold>{ask.title}</Text><Text>{mediaSizeWords(ask.bytes)} download → {ask.root}</Text><Text>{ask.license}</Text><Text>{ask.source}</Text><Text>y download · n back</Text></Box>
  if (!snapshot) return <Box><Text>{error ? stripTerminalControls(error) : 'Local images and video'}</Text></Box>
  const visible = Math.max(1, Math.floor((geometry.rowBudget - 4) / 2))
  const start = Math.max(0, Math.min(cursor - 1, snapshot.rows.length - visible))
  return <Box flexDirection="column">
    <Text color={cursor === 0 ? tokens.accent : tokens.textPrimary}>{cursor === 0 ? '› ' : '  '}stable-diffusion.cpp · {snapshot.runtimeInstalled ? 'installed' : `pull ${mediaSizeWords(snapshot.catalogue.runtime.bytes)}`} · MIT</Text>
    {snapshot.rows.slice(start, start + visible).map((item, index) => <Box key={item.model.id} flexDirection="column">
      <Text color={cursor === start + index + 1 ? tokens.accent : tokens.textPrimary}>{cursor === start + index + 1 ? '› ' : '  '}{item.model.id} · {item.model.kind} · {item.model.license}{snapshot.config[item.model.kind === 'image' ? 'imageModel' : 'videoModel'] === item.model.id ? ' · default' : ''}</Text>
      <Text wrap="truncate-end" dimColor>  {item.words}</Text>
    </Box>)}
    {busy ? <Text wrap="truncate-end">{stripTerminalControls(busy)} · esc cancels</Text> : null}
    {notice ? <Text wrap="truncate-end">{stripTerminalControls(notice)}</Text> : null}
    {error ? <Text color={tokens.failure}>{stripTerminalControls(error)}</Text> : null}
  </Box>
}

function ImageTestProgress({ model, controller }: { model: string; controller: AbortController }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  React.useEffect(() => { frame.setOwnsEscape(true); return () => frame.setOwnsEscape(false) }, [frame.setOwnsEscape])
  useInput((_input, key, event) => { if (key.escape) { event.stopImmediatePropagation(); controller.abort() } })
  return <Box flexDirection="column"><Text>{model} · 256×256</Text><Text>A red apple on a wooden table, soft daylight</Text></Box>
}

export function imageSetupPopupRequest(io: ImageSetupIo, preview?: MediaTestImage, initialError?: string): SettingsPopupRequest {
  return { view: 'imagesetup', width: columns => Math.min(110, columns), rows: 30, line: 'Local images and video', hint: IMAGE_SETUP_HINT, bodyOwnsEscape: true, body: geometry => <ImageSetupBody geometry={geometry} io={io} {...(preview ? { preview } : {})} {...(initialError ? { initialError } : {})} /> }
}

export async function call(_args: string, context: LocalJSXCommandContext): Promise<LocalCommandResult> {
  openSettingsPopup(imageSetupPopupRequest(imageSetupIo(context)))
  return { type: 'skip' }
}
