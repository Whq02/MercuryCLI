export const XAI_SURFACES_LANE_STUB = 'stub for the xai surfaces lane — replaced by the xai wire lane at the fold' as const
import { XAI_DISPLAY_PINS, xaiCurrentModelId, type XaiDisplayPin } from './xaiPins.js'

export interface XaiLiveModel {
  id: string
  ownedBy?: string
  displayName?: string
}

export function decodeXaiModel(raw: unknown): XaiLiveModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = (raw as Record<string, unknown>).id
  return typeof id === 'string' && id.trim() !== '' ? { id: id.trim() } : undefined
}

export async function fetchXaiLiveModels(_opts: {
  baseUrl: string
  key: string
  fetchImpl?: typeof fetch
}): Promise<{ models: XaiLiveModel[]; fetchedAtMs: number }> {
  return { models: [], fetchedAtMs: 0 }
}

export interface XaiCatalogueSnapshot {
  keySource: 'env' | 'stored'
  models: XaiLiveModel[]
  fetchedAtMs: number
  lastAttemptAtMs?: number
  lastError?: string
}

export function getCachedXaiCatalogue(_env: NodeJS.ProcessEnv = process.env): XaiCatalogueSnapshot | null {
  return null
}

const EMPTY_LIVE_IDS: ReadonlySet<string> = new Set<string>()

export function cachedLiveIds(_env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return EMPTY_LIVE_IDS
}

export function refreshXaiCatalogue(_opts?: {
  force?: boolean
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}): Promise<XaiCatalogueSnapshot | null> {
  return Promise.resolve(null)
}

export function kickXaiCatalogue(_opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): boolean {
  return false
}

export interface XaiCatalogueRow {
  id: string
  displayName: string
  observedAt: string
  contextWindow?: number
  listedLive: boolean
}

export type XaiCatalogueSource =
  | { kind: 'live'; count: number; fetchedAtMs: number }
  | { kind: 'pin'; observedAt: string }

function pinRow(pin: XaiDisplayPin, listedLive: boolean): XaiCatalogueRow {
  return {
    id: xaiCurrentModelId(pin.id),
    displayName: pin.displayName,
    observedAt: pin.observedAt,
    ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
    listedLive,
  }
}

export function xaiCatalogueRows(_env: NodeJS.ProcessEnv = process.env): {
  rows: XaiCatalogueRow[]
  source: XaiCatalogueSource
} {
  return {
    rows: XAI_DISPLAY_PINS.map(pin => pinRow(pin, false)),
    source: { kind: 'pin', observedAt: XAI_DISPLAY_PINS[0]?.observedAt ?? '' },
  }
}

export function xaiCatalogueSourceWords(_env: NodeJS.ProcessEnv = process.env): string | undefined {
  return undefined
}

export function __resetXaiCatalogueForTest(): void {}
