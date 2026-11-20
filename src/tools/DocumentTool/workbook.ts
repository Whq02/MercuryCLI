import type ExcelJS from 'exceljs'

type WorkbookBuffer = ExcelJS.Buffer | Uint8Array | ArrayBuffer

type WorkbookXlsx = Omit<ExcelJS.Xlsx, 'load'> & {
  load(buffer: WorkbookBuffer, options?: Partial<ExcelJS.XlsxReadOptions>): Promise<ExcelJS.Workbook>
}

type WorkbookImage = Omit<ExcelJS.Image, 'buffer'> & { buffer?: WorkbookBuffer }

type WorkbookInstance = Omit<ExcelJS.Workbook, 'xlsx' | 'addImage'> & {
  xlsx: WorkbookXlsx
  addImage(img: WorkbookImage): number
}

export const { Workbook } = require('exceljs/lib/exceljs.bare.js') as { Workbook: new () => WorkbookInstance }
export type Buffer = ExcelJS.Buffer
