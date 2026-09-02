
import { getGlobalConfig, saveGlobalConfig } from './config/globalConfig.js'

export type HeadlessActivityKind = 'print' | 'sdk' | `verb:${string}`

export interface HeadlessActivity {
  print: number
  sdk: number
  verbs: Record<string, number>
  lastKind: string
  lastAt: number
}

const EMPTY: HeadlessActivity = { print: 0, sdk: 0, verbs: {}, lastKind: '', lastAt: 0 }

export function noteHeadlessActivity(kind: HeadlessActivityKind): void {
  try {
    saveGlobalConfig(current => {
      const prev = (current.headlessActivity as HeadlessActivity | undefined) ?? EMPTY
      const next: HeadlessActivity = {
        print: prev.print + (kind === 'print' ? 1 : 0),
        sdk: prev.sdk + (kind === 'sdk' ? 1 : 0),
        verbs: kind.startsWith('verb:')
          ? { ...prev.verbs, [kind.slice(5)]: (prev.verbs[kind.slice(5)] ?? 0) + 1 }
          : prev.verbs,
        lastKind: kind,
        lastAt: Date.now(),
      }
      return { ...current, headlessActivity: next }
    })
  } catch {
  }
}

export function getHeadlessActivity(): HeadlessActivity {
  try {
    return (getGlobalConfig().headlessActivity as HeadlessActivity | undefined) ?? EMPTY
  } catch {
    return EMPTY
  }
}
