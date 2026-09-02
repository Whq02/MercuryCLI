// ============================================================================
//  src/constants/apiLimits.ts — server-side media/PDF limits as named
//  constants. Contract data: exact values are the interoperability contract.
//  This module must stay dependency-free to avoid import cycles.
// ============================================================================

/** Max size of a base64-ENCODED image the API accepts — the string length,
 *  not raw bytes (base64 inflates by about a third). */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024

/** Target raw image size: three-quarters of the base64 cap, leaving room for
 *  the inflation. */
export const IMAGE_TARGET_RAW_SIZE = Math.floor((API_IMAGE_MAX_BASE64_SIZE * 3) / 4)

// Client-side resize bounds — deliberately larger than the server's own
// 1568px internal resize, which is handled server-side and never errors.
export const IMAGE_MAX_WIDTH = 2000
export const IMAGE_MAX_HEIGHT = 2000

/** Target raw PDF size: the request limit is 32 MiB total and base64
 *  inflation leaves room for context. */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024

/** Max PDF pages the API accepts. */
export const API_PDF_MAX_PAGES = 100

/** Above this raw size, PDFs are extracted to page images instead of sent as
 *  base64 document blocks; non-first-party providers always extract. */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024

/** Max PDF size accepted on the extraction path. */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024

/** Max pages the read tool extracts in one call. */
export const PDF_MAX_PAGES_PER_READ = 20

/** At-mention inlining threshold: above this page count a PDF gets reference
 *  treatment rather than being inlined. */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10

/** Max media items (images plus PDFs) per request — validated client-side
 *  because the server error is confusing. */
export const API_MAX_MEDIA_PER_REQUEST = 100
