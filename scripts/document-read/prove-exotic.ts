import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, reader, scratch, zip } from './hardening-fixtures.ts'

const root = scratch('structure')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
const multilingual = 'مرحبا שלום 日本語 中文 한국어'
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${multilingual}</t></is></c><c r="C1"><f>SUM(1,2)</f><v>3</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>`
const slide = (text: string) => `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128])
const fixtures: [string, Record<string, string | Buffer>, RegExp[]][] = [
  ['document.docx', {
    'word/document.xml': `<w:document xmlns:w="w"><w:body>${p(multilingual)}<w:p><w:ins><w:r><w:t>new wording</w:t></w:r></w:ins><w:del><w:r><w:delText>old wording</w:delText></w:r></w:del><w:r><w:footnoteReference w:id="1"/><w:commentReference w:id="2"/></w:r></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p('merged heading')}</w:tc></w:tr><w:tr><w:tc>${p('left')}</w:tc><w:tc>${p('right')}</w:tc></w:tr></w:tbl></w:body></w:document>`,
    'word/footnotes.xml': `<w:footnotes xmlns:w="w"><w:footnote w:id="1">${p('footnote body')}</w:footnote></w:footnotes>`,
    'word/comments.xml': `<w:comments xmlns:w="w"><w:comment w:id="2" w:author="Reviewer">${p('comment body')}</w:comment></w:comments>`,
    'word/media/chart.png': image,
  }, [/\[inserted: new wording\]/, /\[deleted: old wording\]/, /\[\^1\]: footnote body/, /\[comment 2, Reviewer\] comment body/, /merged heading.*colspan 2/, /\| left \| right \|/, /Image: word\/media\/chart\.png/]],
  ['book.xlsx', {
    'xl/workbook.xml': '<workbook><sheets><sheet name="First" r:id="rId2"/><sheet name="Second" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet2.xml': sheet,
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="inlineStr"><is><t>second sheet</t></is></c></row></sheetData></worksheet>',
    'xl/media/chart.png': image,
  }, [/## First[\s\S]*## Second/, /3 \[=SUM\(1,2\)\]/, /Merged cells: A1:B1/, /second sheet/, /Image: xl\/media\/chart\.png/]],
  ['slides.pptx', {
    'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide(multilingual),
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide1.xml': slide('speaker notes'),
    'ppt/media/chart.png': image,
  }, [/## Slide 1/, /### Notes\nspeaker notes/, /Image: ppt\/media\/chart\.png/]],
]
try {
  const { read, healthy } = await reader(root)
  const missing: string[] = []
  for (const [name, parts, expected] of fixtures) {
    const path = join(root, name); writeFileSync(path, zip(parts))
    const output = await read(path)
    console.log(`${name}\n${output}`)
    assert.ok(output.includes(multilingual), `${name} lost RTL or CJK characters`)
    assert.doesNotMatch(output, /iVBOR|89504e47|�/)
    for (const pattern of expected) if (!pattern.test(output)) missing.push(`${name}: ${pattern}`)
    await healthy()
  }
  assert.deepEqual(missing, [])
  console.log('PASS tracked changes, notes, comments, merged tables, formulas, sheet order, RTL/CJK and named images; session healthy')
} finally { cleanup(root) }
