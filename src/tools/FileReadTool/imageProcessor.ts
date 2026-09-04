import { flagEnv } from '../../substrate/flagRegistry.js'
import { armImagePack, imagePackPackages, imagePackPlatform, vendoredImagePackDir } from './imagePackArm.js'
import { javascriptImageProcessor } from './imageProcessorJs.js'

export { IMAGE_PACK_PATH, armImagePack, imagePackPackages, imagePackPlatform, vendoredImagePackDir } from './imagePackArm.js'

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

export type ImageProcessorState =
  | {
      road: 'native'
      source: 'vendored' | 'node_modules'
      sharp: string
      libvips: string
      packDir: string
    }
  | {
      road: 'javascript'
      reason: string
      packDir: string
    }

type Loaded = { processor: SharpFunction; state: ImageProcessorState }

let loadedPromise: Promise<Loaded> | undefined

function load(): Promise<Loaded> {
  if (loadedPromise === undefined) loadedPromise = loadProcessor()
  return loadedPromise
}

export async function getImageProcessor(): Promise<SharpFunction> {
  return (await load()).processor
}

export async function imageProcessorState(): Promise<ImageProcessorState> {
  return (await load()).state
}

function unwrapModule(loaded: unknown): SharpFunction {
  const candidate = loaded as { default?: unknown }
  if (typeof candidate === 'function') return candidate as SharpFunction
  if (typeof candidate?.default === 'function') return candidate.default as SharpFunction
  const shape = candidate && typeof candidate === 'object' ? Object.keys(candidate).slice(0, 12).join(', ') : typeof candidate
  throw new Error(`image processor module did not export a callable entry point (module shape: ${shape || 'empty'})`)
}

async function loadProcessor(): Promise<Loaded> {
  const packPlatform = imagePackPlatform()
  const packDir = vendoredImagePackDir(packPlatform)
  const forced = flagEnv('MERCURY_IMAGE_PROCESSOR')
  if (forced === 'javascript') {
    return { processor: javascriptImageProcessor, state: { road: 'javascript', reason: 'MERCURY_IMAGE_PROCESSOR=javascript', packDir } }
  }
  try {
    const arm = armImagePack(packPlatform)
    const source: 'vendored' | 'node_modules' = arm.armed ? 'vendored' : 'node_modules'
    const native = unwrapModule(await import('sharp'))
    const versions = (native as unknown as { versions?: { sharp?: string; vips?: string } }).versions
    return {
      processor: native,
      state: { road: 'native', source, sharp: versions?.sharp ?? 'unknown', libvips: versions?.vips ?? 'unknown', packDir },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const reason = message.split('\n')[0] ?? message
    return { processor: javascriptImageProcessor, state: { road: 'javascript', reason, packDir } }
  }
}

export async function describeImageProcessor(): Promise<{ ready: boolean; line: string; detail?: string }> {
  const state = await imageProcessorState()
  if (state.road === 'native') {
    return {
      ready: true,
      line: `native image processor — sharp ${state.sharp} · libvips ${state.libvips} (${state.source === 'vendored' ? `vendored pack ${state.packDir}` : 'node_modules beside the bundle'})`,
    }
  }
  return {
    ready: false,
    line: `JavaScript image road — the native processor did not load (${state.reason})`,
    detail: `PNG and BMP images still shrink to the provider's limits here; a JPEG, WebP or GIF over a limit cannot be re-encoded until the pack is present. The pack for this platform sits at ${state.packDir} in a build that vendored it (${imagePackPackages(imagePackPlatform()).join(' + ')}).`,
  }
}
