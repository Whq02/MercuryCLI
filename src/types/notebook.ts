
export type NotebookCellType = 'code' | 'markdown' | 'raw'

export interface NotebookCell {
  cell_type: NotebookCellType
  id?: string
  source: string | string[]
  metadata: Record<string, unknown>
  execution_count?: number | null
  outputs?: NotebookCellOutput[]
}

export type NotebookCellMetadata = Record<string, unknown>

export type NotebookCellOutput =
  | NotebookStreamOutput
  | NotebookDisplayDataOutput
  | NotebookExecuteResultOutput
  | NotebookErrorOutput

export interface NotebookStreamOutput {
  output_type: 'stream'
  name?: string
  text: string | string[]
}

export interface NotebookDisplayDataOutput {
  output_type: 'display_data'
  data?: NotebookMimeBundle
  metadata?: Record<string, unknown>
}

export interface NotebookExecuteResultOutput {
  output_type: 'execute_result'
  data?: NotebookMimeBundle
  metadata?: Record<string, unknown>
  execution_count?: number | null
}

export interface NotebookErrorOutput {
  output_type: 'error'
  ename: string
  evalue: string
  traceback: string[]
}

export type NotebookMimeBundle = Record<string, string | string[]>

export interface NotebookOutputImage {
  image_data: string
  media_type: 'image/png' | 'image/jpeg'
}

export interface NotebookMetadata {
  language_info?: NotebookLanguageInfo
  kernelspec?: NotebookKernelSpec
  [key: string]: unknown
}

export interface NotebookLanguageInfo {
  name?: string
  version?: string
  file_extension?: string
  mimetype?: string
}

export interface NotebookKernelSpec {
  name?: string
  display_name?: string
  language?: string
}

export interface NotebookContent {
  cells: NotebookCell[]
  metadata: NotebookMetadata
  nbformat: number
  nbformat_minor: number
}

export interface NotebookCellSourceOutput {
  output_type: string
  text?: string
  image?: NotebookOutputImage
}

export interface NotebookCellSource {
  cellType: NotebookCellType
  source: string
  execution_count?: number
  cell_id: string
  language?: string
  outputs?: NotebookCellSourceOutput[]
}
