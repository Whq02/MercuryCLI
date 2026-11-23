import type { ImageDimensions } from '../../platform/images/imageResizer.js'
import type { NotebookCellSource } from '../../tools/kit/notebookShapes.js'

export type OverCapNote = { tokens: number; maxTokens: number; next: { offset: number; limit: number }; room?: true }

export type FileReadToolOutput =
  | {
      type: 'text'
      file: {
        filePath: string
        content: string
        numLines: number
        startLine: number
        totalLines: number
        overCap?: OverCapNote
        lossless?: boolean
        reminder?: string
        anchor?: string
        memoryUpdatedAt?: number
      }
    }
  | {
      type: 'image'
      file: {
        base64: string
        type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
        originalSize: number
        dimensions?: ImageDimensions
        caption?: string
      }
    }
  | { type: 'notebook'; file: { filePath: string; cells: NotebookCellSource[] } }
  | { type: 'pdf'; file: { filePath: string; base64: string; originalSize: number } }
  | {
      type: 'parts'
      file: { filePath: string; originalSize: number; count: number; outputDir: string }
    }
  | { type: 'file_unchanged'; file: { filePath: string; anchor?: string } }
