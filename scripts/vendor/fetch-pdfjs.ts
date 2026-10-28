import { resolve } from 'node:path'
import { checkPdfjs, fetchPdfjs } from './pdfjs.ts'

const root = resolve(import.meta.dir, '../..')
if (process.argv.includes('--check')) checkPdfjs(root)
else await fetchPdfjs(root, process.argv.find(arg => arg.startsWith('--archive='))?.slice(10))
console.log('PDF.js vendor cache matches its lock')
