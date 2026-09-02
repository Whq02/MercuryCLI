import { isInBundledMode } from '../../utils/bundledMode.js'


export type SharpInstance = {
  metadata(): Promise<{ width?: number; height?: number; format?: string }>
  resize(
    width: number | null,
    height?: number | null,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    quality?: number
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input?: Buffer | string) => SharpInstance

function unwrapModule(loaded: unknown): SharpFunction {
  const candidate = loaded as { default?: unknown }
  if (typeof candidate === 'function') return candidate as SharpFunction
  if (typeof candidate?.default === 'function') return candidate.default as SharpFunction
  throw new Error('image processor module did not export a callable entry point')
}

let processorPromise: Promise<SharpFunction> | undefined

export function getImageProcessor(): Promise<SharpFunction> {
  if (processorPromise === undefined) {
    processorPromise = loadProcessor()
  }
  return processorPromise
}

async function loadProcessor(): Promise<SharpFunction> {
  if (isInBundledMode()) {
    try {
      const native = (await import('image-processor-napi')) as {
        sharp?: unknown
        default?: unknown
      }
      if (typeof native.sharp === 'function') return native.sharp as SharpFunction
      if (typeof native.default === 'function') return native.default as SharpFunction
      throw new Error('native image module exported no callable entry point')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `Native image processor unavailable, falling back to sharp: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return unwrapModule(await import('sharp'))
}
