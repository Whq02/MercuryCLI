/**
 * Jupyter notebook (.ipynb) type definitions.
 *
 * These model the on-disk nbformat v4 JSON schema (the shape `NotebookEditTool`
 * reads, mutates in place, and writes back) plus the *processed* cell shape the
 * `utils/notebook.ts` reader produces for tool results.
 *
 * The on-disk types are intentionally a flat interface (not a discriminated
 * union on `cell_type`): `NotebookEditTool.call()` mutates `targetCell.cell_type`
 * from one literal to another on an already-typed cell, which a discriminated
 * union would reject. Code-only fields (`execution_count`, `outputs`) are
 * therefore optional and the reader narrows on `cell.cell_type === 'code'`.
 */

/** The kind of a notebook cell (nbformat cell_type). */
export type NotebookCellType = 'code' | 'markdown' | 'raw'

/**
 * A single cell as stored in the notebook JSON (nbformat v4).
 *
 * `source` is `string | string[]`: nbformat stores multi-line source as an
 * array of line strings, but a single string is also valid and is what the
 * edit tool writes.
 */
export interface NotebookCell {
  cell_type: NotebookCellType
  /** Present in nbformat >= 4.5; may be absent (older notebooks) or unset on insert. */
  id?: string
  source: string | string[]
  metadata: Record<string, unknown>
  /** Code cells only: execution counter, `null` before/after a reset. */
  execution_count?: number | null
  /** Code cells only: the rendered outputs. */
  outputs?: NotebookCellOutput[]
}

/** Per-cell metadata bag (free-form by the nbformat spec). */
export type NotebookCellMetadata = Record<string, unknown>

/**
 * The output of a code cell, as stored in the notebook JSON. Discriminated on
 * `output_type` (the nbformat output schema).
 */
export type NotebookCellOutput =
  | NotebookStreamOutput
  | NotebookDisplayDataOutput
  | NotebookExecuteResultOutput
  | NotebookErrorOutput

/** `stream` output (stdout/stderr). `text` may be a joined string or line array. */
export interface NotebookStreamOutput {
  output_type: 'stream'
  /** Stream name, e.g. `stdout` / `stderr`. */
  name?: string
  text: string | string[]
}

/** `display_data` output: a MIME bundle (e.g. `text/plain`, `image/png`). */
export interface NotebookDisplayDataOutput {
  output_type: 'display_data'
  data?: NotebookMimeBundle
  metadata?: Record<string, unknown>
}

/** `execute_result` output: a MIME bundle plus an execution counter. */
export interface NotebookExecuteResultOutput {
  output_type: 'execute_result'
  data?: NotebookMimeBundle
  metadata?: Record<string, unknown>
  execution_count?: number | null
}

/** `error` output: an exception name, value, and formatted traceback lines. */
export interface NotebookErrorOutput {
  output_type: 'error'
  ename: string
  evalue: string
  traceback: string[]
}

/**
 * A MIME bundle keyed by media type (`text/plain`, `image/png`, `image/jpeg`,
 * …). nbformat stores each representation as a base64 string (images) or a
 * `string | string[]` (text, possibly split into lines). The reader narrows
 * per key (`typeof === 'string'` for images, join-if-array for text), so the
 * value type is `string | string[]` — assignable to the `Record<string,
 * unknown>` that `extractImage` accepts.
 */
export type NotebookMimeBundle = Record<string, string | string[]>

/** A decoded inline image extracted from a cell's MIME bundle. */
export interface NotebookOutputImage {
  /** Base64-encoded image bytes (whitespace stripped). */
  image_data: string
  /** A subset of the Anthropic SDK `Base64ImageSource.media_type` union. */
  media_type: 'image/png' | 'image/jpeg'
}

/** Top-level notebook metadata (nbformat `metadata`). */
export interface NotebookMetadata {
  language_info?: NotebookLanguageInfo
  kernelspec?: NotebookKernelSpec
  [key: string]: unknown
}

/** `metadata.language_info`: the notebook's code language. */
export interface NotebookLanguageInfo {
  name?: string
  version?: string
  file_extension?: string
  mimetype?: string
}

/** `metadata.kernelspec`: the kernel the notebook was authored against. */
export interface NotebookKernelSpec {
  name?: string
  display_name?: string
  language?: string
}

/**
 * A parsed Jupyter notebook file (nbformat v4 top-level object).
 */
export interface NotebookContent {
  cells: NotebookCell[]
  metadata: NotebookMetadata
  /** Major nbformat version (4 for current notebooks). */
  nbformat: number
  /** Minor nbformat version (cell ids require >= 4.5). */
  nbformat_minor: number
}

/**
 * A processed cell output, ready to be turned into a tool-result block. This is
 * the reader's *projection* of `NotebookCellOutput` (text flattened, images
 * decoded) — not the on-disk shape.
 */
export interface NotebookCellSourceOutput {
  output_type: string
  text?: string
  image?: NotebookOutputImage
}

/**
 * A processed cell, ready to be turned into tool-result blocks. This is the
 * reader's projection of `NotebookCell` (source flattened to a string, outputs
 * processed) — what `readNotebook()` returns.
 */
export interface NotebookCellSource {
  cellType: NotebookCellType
  source: string
  /** Code cells: the (cleaned) execution counter; `undefined` otherwise. */
  execution_count?: number
  cell_id: string
  /** Code cells only: the notebook's code language. */
  language?: string
  /** Code cells only: the processed outputs. */
  outputs?: NotebookCellSourceOutput[]
}
