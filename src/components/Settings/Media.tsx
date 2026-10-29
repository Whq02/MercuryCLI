import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import TextInput from '../TextInput.js'
import { Select } from '../CustomSelect/select.js'
import { readMediaCatalogue, type MediaCatalogue } from '../../services/media/catalogue.js'
import { mediaConfigModule, mediaRoot, readMediaSettings, saveMediaSettings, type MediaConfig, type MediaSettings } from '../../services/media/settings.js'

export type MediaMenu = 'media-root' | 'media-image' | 'media-video'
type MediaConfigItem = { id: string; label: string; kind: 'boolean' | 'managed-enum'; value: React.ReactElement; change?: (direction: 1 | -1) => void; open?: MediaMenu; setByYou: boolean; warning?: string }

export function useMediaConfig(): {
  items: MediaConfigItem[]; settings: MediaSettings; catalogue: MediaCatalogue | null; config: MediaConfig; error: string; dirty: boolean;
  change: (patch: MediaSettings) => void; save: () => Promise<boolean>; revert: () => void
} {
  const [initial, setInitial] = React.useState(readMediaSettings)
  const [draft, setDraft] = React.useState<MediaSettings>({})
  const [catalogue, setCatalogue] = React.useState<MediaCatalogue | null>(null)
  const [config, setConfig] = React.useState<MediaConfig>({})
  const [error, setError] = React.useState('')
  const settings = { enabled: initial.enabled, root: initial.root, serverPath: initial.serverPath, ...draft }
  React.useEffect(() => {
    let active = true
    const current = { ...initial, ...draft }
    void Promise.all([readMediaCatalogue(current), mediaConfigModule(current).then(module => module.readMediaConfig(mediaRoot(current)))]).then(([catalogue, config]) => {
      if (active) { setCatalogue(catalogue); setConfig(config); setError('') }
    }, error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [initial, draft.root])
  const change = (patch: MediaSettings): void => { setDraft(current => ({ ...current, ...patch })); setError('') }
  return {
    settings, catalogue, config, error, dirty: Object.keys(draft).length > 0,
    change,
    save: async () => {
      if (!Object.keys(draft).length) return false
      try {
        const reconnect = (['enabled', 'root', 'serverPath'] as const).some(key => key in draft && draft[key] !== initial[key])
        await saveMediaSettings(draft)
        setInitial(readMediaSettings())
        setDraft({})
        setError('')
        return reconnect
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
        throw error
      }
    },
    revert: () => { setDraft({}); setError('') },
    items: [
      { id: 'media.enabled', label: 'Local media', kind: 'boolean', value: <Text>{settings.enabled ? 'on' : 'off'}</Text>, setByYou: settings.enabled === true, warning: error || '/imagesetup installs the runtime and models.', change: () => change({ enabled: !settings.enabled }) },
      { id: 'media.root', label: 'Media folder', kind: 'managed-enum', value: <Text>{settings.root ?? mediaRoot(settings)}</Text>, setByYou: settings.root !== undefined, open: 'media-root' },
      { id: 'media.imageModel', label: 'Default image model', kind: 'managed-enum', value: <Text>{draft.imageModel ?? config.imageModel ?? 'Choose a model'}</Text>, setByYou: settings.imageModel !== undefined, open: 'media-image' },
      { id: 'media.videoModel', label: 'Default video model', kind: 'managed-enum', value: <Text>{draft.videoModel ?? config.videoModel ?? 'Choose a model'}</Text>, setByYou: settings.videoModel !== undefined, open: 'media-video' },
    ],
  }
}

export function MediaConfigPicker({ menu, media, rows, width, onClose }: { menu: MediaMenu; media: ReturnType<typeof useMediaConfig>; rows: number; width: number; onClose: () => void }): React.ReactNode {
  const [path, setPath] = React.useState(media.settings.root ?? mediaRoot(media.settings))
  const [error, setError] = React.useState('')
  const [cursor, setCursor] = React.useState(path.length)
  useInput((_input, key, event) => { if (key.escape) { event.stopImmediatePropagation(); onClose() } }, { isActive: menu === 'media-root' })
  if (menu === 'media-root') return <Box flexDirection="column"><Text>Media folder</Text><TextInput columns={width} value={path} onChange={setPath} cursorOffset={cursor} onChangeCursorOffset={setCursor} onSubmit={() => {
    try { mediaRoot({ root: path }); media.change({ root: path }); onClose() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }} />{error ? <Text>{error}</Text> : null}<Text dimColor>Enter keeps the folder · esc back</Text></Box>
  const kind = menu === 'media-image' ? 'image' : 'video'
  const key = kind === 'image' ? 'imageModel' : 'videoModel'
  const current = media.settings[key] ?? media.config[key]
  const models = media.catalogue?.models.filter(model => model.kind === kind && !model.control && !model.upscaler) ?? []
  if (!models.length) return <Box flexDirection="column"><Text>{media.error || 'Open /imagesetup to choose a model.'}</Text><Select options={[{ label: 'Back', value: 'back' }]} onChange={onClose} onCancel={onClose} /></Box>
  return <Select visibleOptionCount={Math.max(1, rows)} options={models.map(model => ({ label: `${model.id} · ${model.license}`, value: model.id }))} {...(current ? { defaultValue: current, defaultFocusValue: current } : {})} onChange={model => { media.change({ [key]: model }); onClose() }} onCancel={onClose} />
}
