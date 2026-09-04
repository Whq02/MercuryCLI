
export type ImageLimitFamily = 'anthropic' | 'openai' | 'gemini' | 'generic'

export interface ImageLimits {
  family: ImageLimitFamily
  doc: string
  maxSidePx: number | null
  manyImages: { threshold: number; maxSidePx: number } | null
  maxBase64Bytes: number
  nativeLongEdgePx: { standard: number; highResolution: number }
  toolResultRejectsAboveNative: boolean
  maxImagesPerRequest: number
  maxRequestBytes: number
}

const MiB = 1024 * 1024

export const ANTHROPIC_IMAGE_LIMITS: ImageLimits = {
  family: 'anthropic',
  doc: 'https://platform.claude.com/docs/en/build-with-claude/vision',
  maxSidePx: 8000,
  manyImages: { threshold: 20, maxSidePx: 2000 },
  maxBase64Bytes: 10 * MiB,
  nativeLongEdgePx: { standard: 1568, highResolution: 2576 },
  toolResultRejectsAboveNative: true,
  maxImagesPerRequest: 100,
  maxRequestBytes: 32 * MiB,
}

export const OPENAI_IMAGE_LIMITS: ImageLimits = {
  family: 'openai',
  doc: 'https://developers.openai.com/api/docs/guides/images-vision',
  maxSidePx: null,
  manyImages: null,
  maxBase64Bytes: 512 * MiB,
  nativeLongEdgePx: { standard: 2048, highResolution: 2048 },
  toolResultRejectsAboveNative: false,
  maxImagesPerRequest: 1500,
  maxRequestBytes: 512 * MiB,
}

export const GEMINI_IMAGE_LIMITS: ImageLimits = {
  family: 'gemini',
  doc: 'https://ai.google.dev/gemini-api/docs/image-understanding',
  maxSidePx: null,
  manyImages: null,
  maxBase64Bytes: 20 * MiB,
  nativeLongEdgePx: { standard: 768, highResolution: 768 },
  toolResultRejectsAboveNative: false,
  maxImagesPerRequest: 3600,
  maxRequestBytes: 20 * MiB,
}

export const GENERIC_IMAGE_LIMITS: ImageLimits = {
  family: 'generic',
  doc: 'https://platform.claude.com/docs/en/build-with-claude/vision',
  maxSidePx: 8000,
  manyImages: { threshold: 20, maxSidePx: 2000 },
  maxBase64Bytes: 5 * MiB,
  nativeLongEdgePx: { standard: 1568, highResolution: 1568 },
  toolResultRejectsAboveNative: true,
  maxImagesPerRequest: 100,
  maxRequestBytes: 32 * MiB,
}

export const IMAGE_LIMITS_BY_FAMILY: Readonly<Record<ImageLimitFamily, ImageLimits>> = {
  anthropic: ANTHROPIC_IMAGE_LIMITS,
  openai: OPENAI_IMAGE_LIMITS,
  gemini: GEMINI_IMAGE_LIMITS,
  generic: GENERIC_IMAGE_LIMITS,
}

export const STRICTEST_IMAGE_MAX_BASE64_BYTES = Math.min(
  ...Object.values(IMAGE_LIMITS_BY_FAMILY).map(limits => limits.maxBase64Bytes),
)

export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024

export const API_PDF_MAX_PAGES = 100

export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024

export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024

export const PDF_MAX_PAGES_PER_READ = 20

export const PDF_AT_MENTION_INLINE_THRESHOLD = 10

export const API_MAX_MEDIA_PER_REQUEST = 100
