import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { RawAnsi } from '../../ink/components/RawAnsi.js'
import { useSettingsPopupFrame } from '../../components/Settings/Settings.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from '../../components/mercury-ui/useOpenEventGate.js'
import { imageToCells } from '../../services/visual/imageDisplay.js'
import { gibWords } from '../../services/localServer/localServerMemory.js'
import { mediaAddPlan, mediaAddSource, mediaPullPlan, mediaProgressWords, mediaRuntimeRowWords, mediaSizeWords, pullMedia, readMediaSnapshot, runMediaSetup, MediaSetupPaused, type MediaPullPlan, type MediaSnapshot } from '../../services/media/setup.js'
import { saveMediaSettings, readMediaSettings } from '../../services/media/settings.js'
import { mediaHostChoices } from '../../services/media/host.js'
import { hostPaidPodWords, LLM_HOST_WORDS } from '../llmhost/words.js'
import { generateMediaTestImage, type MediaTestImage } from '../../services/media/generation.js'
import { openSettingsPopup, closeSettingsPopup, type SettingsPopupGeometry, type SettingsPopupRequest } from '../../utils/cockpit/settingsPopup.js'
import { stripTerminalControls } from '../../utils/stringUtils.js'
import { reloadExtensions, noteReloaded } from '../../extensions/boot.js'
import { extensionsStateFrom } from '../../hooks/useExtensions.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'

export const IMAGE_SETUP_HINT = '↑↓ select · p pull · d default · t test image · esc closes'
export type ImageSetupIo = {
  read: () => Promise<MediaSnapshot>
  places?: () => { id: string; words: string }[]
  choose?: (id: string) => Promise<void>
  pull: typeof runMediaSetup
  setDefault: (kind: 'image' | 'video', model: string) => Promise<void>
  test: (model: string, controller: AbortController, onStart?: () => void) => Promise<MediaTestImage>
}

export function imageSetupIo(context: LocalJSXCommandContext): ImageSetupIo {
  const refresh = async (): Promise<void> => {
    if (!readMediaSettings().enabled) return
    const pending = reloadExtensions({ onServersChanged: () => context.setAppState(prev => ({ ...prev, mcp: { ...prev.mcp, extensionReconnectKey: prev.mcp.extensionReconnectKey + 1 } })) })
    noteReloaded(pending)
    const result = await pending
    context.setAppState(prev => ({ ...prev, extensions: extensionsStateFrom(result.set, false, null) }))
  }
  return {
    read: () => readMediaSnapshot(),
    places: () => [{ id: '', words: 'Local images and video' }, ...mediaHostChoices().map(record => ({ id: record.id, words: hostPaidPodWords({ ...record, cost: record.price, createdAt: record.startedAt }, record) }))],
    choose: async host => { await saveMediaSettings({ host }); await refresh() },
    pull: async (args, onProgress, signal, settings) => {
      await runMediaSetup(args, onProgress, signal, settings)
      const newlyEnabled = ['pull-model', 'add-model'].includes(args[0] ?? '') && !readMediaSettings().enabled
      if (newlyEnabled) await saveMediaSettings({ enabled: true })
      if (newlyEnabled || readMediaSettings().host && args[0] === 'pull-runtime') await refresh()
    },
    setDefault: (kind, model) => saveMediaSettings({ [kind === 'image' ? 'imageModel' : 'videoModel']: model }),
    test: (model, controller, onStart) => generateMediaTestImage(model, context, controller, onStart),
  }
}

export function ImageSetupBody({ geometry, io, preview, initialError, initialSource }: { geometry: SettingsPopupGeometry; io: ImageSetupIo; preview?: MediaTestImage; initialError?: string; initialSource?: string }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  const tokens = useMercuryTokens()
  const pastOpen = useOpenEventGate()
  const [snapshot, setSnapshot] = React.useState<MediaSnapshot | null>(null)
  const [error, setError] = React.useState(initialError ?? '')
  const [cursor, setCursor] = React.useState(0)
  const [places, setPlaces] = React.useState<{ id: string; words: string }[] | null>(null)
  const [placeCursor, setPlaceCursor] = React.useState(0)
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
    frame.setHint(places ? LLM_HOST_WORDS.hint : null)
    frame.setLine(places ? LLM_HOST_WORDS.where : snapshot ? `${snapshot.location ?? snapshot.root} · ${gibWords(snapshot.totalMemoryBytes)} memory · ${mediaSizeWords(snapshot.freeBytes)} free` : 'Local images and video')
    return () => frame.setOwnsEscape(false)
  }, [snapshot, places, frame.setLine, frame.setHint, frame.setOwnsEscape])
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
  const added = React.useRef(false)
  const pendingSource = React.useRef(initialSource)
  const addSource = (source: string): void => {
    if (!snapshot) return
    perform(source, async signal => {
      const settings = { ...readMediaSettings(), ...(!snapshot.host ? { root: snapshot.root } : {}) }
      const run = (args: string[], progress: Parameters<typeof runMediaSetup>[1], signal?: AbortSignal) => io.pull(args, progress, signal, settings)
      const plan = await mediaAddPlan(source, snapshot.root, run, signal)
      const progress: Parameters<typeof runMediaSetup>[1] = event => { if (alive.current) setBusy(mediaProgressWords(event) || plan.title) }
      if (plan.remote) await pullMedia(plan, plan => new Promise(resolve => { consent.current = resolve; setAsk(plan) }), run, progress, signal)
      else await run(plan.args, progress, signal)
      pendingSource.current = undefined
    })
  }
  React.useEffect(() => {
    if (!snapshot || !initialSource || added.current) return
    added.current = true
    addSource(initialSource)
  }, [snapshot, initialSource, io])
  const row = snapshot?.rows[cursor - 1]
  useInput((input, key, event) => {
    if (key.escape) {
      event.stopImmediatePropagation()
      if (ask) { consent.current?.(false); consent.current = null; setAsk(null); return }
      if (operation.current) { operation.current.abort(); return }
      if (places) { setPlaces(null); return }
      if (image) { setImage(undefined); return }
      frame.close()
      return
    }
    if (key.ctrl || key.meta) return
    event.stopImmediatePropagation()
    if (ask) {
      if (input.toLowerCase() === 'y' && pastOpen()) { consent.current?.(true); consent.current = null; setAsk(null) }
      else if (input.toLowerCase() === 'n') { consent.current?.(false); consent.current = null; setAsk(null) }
      return
    }
    if (busy || image) return
    if (places) {
      if (key.upArrow) setPlaceCursor(Math.max(0, placeCursor - 1))
      else if (key.downArrow) setPlaceCursor(Math.min(places.length - 1, placeCursor + 1))
      else if (key.return && pastOpen() && places[placeCursor] && io.choose) {
        const selected = places[placeCursor]!
        setPlaces(null)
        setSnapshot(null)
        perform(selected.words, () => io.choose!(selected.id))
      }
      return
    }
    if (key.return && cursor === 0 && pastOpen() && io.places && io.choose) { setPlaceCursor(0); setPlaces(io.places()); return }
    if (!snapshot) return
    if (key.upArrow) { setCursor(Math.max(0, cursor - 1)); return }
    if (key.downArrow) { setCursor(Math.min(snapshot.rows.length, cursor + 1)); return }
    if (!pastOpen()) return
    if (input === 'p') {
      try {
        if (pendingSource.current) { addSource(pendingSource.current); return }
        const plan = mediaPullPlan(snapshot, row?.model.id)
        perform(plan.title, async signal => {
          await pullMedia(plan, plan => new Promise(resolve => { consent.current = resolve; setAsk(plan) }), (args, progress, signal) => io.pull(args, progress, signal, { ...readMediaSettings(), ...(!snapshot.host ? { root: plan.root } : {}) }), progress => { if (alive.current) setBusy(mediaProgressWords(progress) || plan.title) }, signal)
        })
      } catch (error) { setError(String(error instanceof Error ? error.message : error)) }
    } else if (input === 'd' && !key.ctrl && !key.meta && row && !row.model.control && !row.model.upscaler) {
      perform(row.model.id, () => io.setDefault(row.model.kind, row.model.id))
    } else if (input === 't' && row?.model.kind === 'image' && !row.model.control && !row.model.upscaler) {
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
  if (places) return <Box flexDirection="column">{places.map((place, index) => <Text key={place.id} wrap="truncate-end" color={index === placeCursor ? tokens.accent : tokens.textPrimary}>{index === placeCursor ? '› ' : '  '}{stripTerminalControls(place.words)}</Text>)}</Box>
  if (ask) return <Box flexDirection="column"><Text bold>{ask.title}</Text><Text>{ask.bytes === undefined ? '' : `${mediaSizeWords(ask.bytes)} `}download → {ask.destination ?? ask.root}</Text><Text>{ask.license}</Text><Text>{ask.source}</Text><Text>y download · n back</Text></Box>
  if (!snapshot) return <Box><Text>{error ? stripTerminalControls(error) : 'Local images and video'}</Text></Box>
  const visible = Math.max(1, Math.floor((geometry.rowBudget - 4) / 2))
  const start = Math.max(0, Math.min(cursor - 1, snapshot.rows.length - visible))
  return <Box flexDirection="column">
    <Text color={cursor === 0 ? tokens.accent : tokens.textPrimary}>{cursor === 0 ? '› ' : '  '}{mediaRuntimeRowWords({ ...snapshot, location: snapshot.location ?? 'Local images and video' })}</Text>
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

export function imageSetupPopupRequest(io: ImageSetupIo, preview?: MediaTestImage, initialError?: string, initialSource?: string): SettingsPopupRequest {
  return { view: 'imagesetup', width: columns => Math.min(110, columns), rows: 30, line: 'Local images and video', hint: IMAGE_SETUP_HINT, bodyOwnsEscape: true, body: geometry => <ImageSetupBody geometry={geometry} io={io} {...(preview ? { preview } : {})} {...(initialError ? { initialError } : {})} {...(initialSource ? { initialSource } : {})} /> }
}

export async function call(args: string, context: LocalJSXCommandContext): Promise<LocalCommandResult> {
  const io = imageSetupIo(context)
  try { openSettingsPopup(imageSetupPopupRequest(io, undefined, undefined, mediaAddSource(args))) }
  catch (error) { openSettingsPopup(imageSetupPopupRequest(io, undefined, error instanceof Error ? error.message : String(error))) }
  return { type: 'skip' }
}
