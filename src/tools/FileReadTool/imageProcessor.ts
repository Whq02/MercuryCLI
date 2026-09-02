import { isInBundledMode } from '../../utils/bundledMode.js'

/**
 * Lazy loader for the image-processing backend: the native module in
 * bundled builds (with a one-time console warning and a fall-through on
 * failure), `sharp` otherwise. Both package names are contract data — the
 * bundled build silently loses its native path if they drift.
 */

/** The narrow processing surface the read tool relies on. */
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

/** Unwrap both dynamic-import shapes: module-with-default and bare function. */
function unwrapModule(loaded: unknown): SharpFunction {
  const candidate = loaded as { default?: unknown }
  if (typeof candidate === 'function') return candidate as SharpFunction
  if (typeof candidate?.default === 'function') return candidate.default as SharpFunction
  throw new Error('image processor module did not export a callable entry point')
}

let processorPromise: Promise<SharpFunction> | undefined

/**
 * The processing backend, memoised on first success. Bundled builds try the
 * native module first, accepting either its named `sharp` export or its
 * default export; a load failure warns once on the console and falls
 * through to `sharp`.
 */
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
