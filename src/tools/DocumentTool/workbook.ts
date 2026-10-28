import type ExcelJS from 'exceljs'

export const { Workbook } = require('exceljs/lib/exceljs.bare.js') as Pick<typeof ExcelJS, 'Workbook'>
export type Buffer = ExcelJS.Buffer
