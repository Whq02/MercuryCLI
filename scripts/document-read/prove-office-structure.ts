import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { renderDocumentTarget } from '../../src/tools/FileReadTool/readRichFormats.ts'

const root = mkdtempSync(join(tmpdir(), 'office-structure-'))
const render = (ext: string, entries: Record<string, string>) => {
  const path = join(root, `fixture.${ext}`)
  writeFileSync(path, zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]))))
  return renderDocumentTarget(path, ext)
}
try {
  const docx = render('docx', {
    'word/document.xml': '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Research</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Finding</w:t><w:footnoteReference w:id="1"/><w:commentReference w:id="2"/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Trial</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    'word/footnotes.xml': '<w:footnotes><w:footnote w:id="1"><w:p><w:r><w:t>Footnote detail</w:t></w:r></w:p></w:footnote></w:footnotes>',
    'word/comments.xml': '<w:comments><w:comment w:id="2" w:author="Reviewer"><w:p><w:r><w:t>Check this</w:t></w:r></w:p></w:comment></w:comments>',
  })
  assert.match(docx, /# Research/)
  assert.match(docx, /- Finding\[\^1\]\[comment 2\]/)
  assert.match(docx, /\| Trial \| 42 \|/)
  assert.match(docx, /\[\^1\]: Footnote detail/)
  assert.match(docx, /\[comment 2, Reviewer\] Check this/)
  const xlsx = render('xlsx', {
    'xl/workbook.xml': '<workbook><sheets><sheet name="Results" r:id="rId9"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId9" Target="worksheets/sheet7.xml"/></Relationships>',
    'xl/worksheets/sheet7.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Trial</t></is></c><c r="C1"><f>SUM(A2:A5)</f><v>42</v></c></row></sheetData></worksheet>',
  })
  assert.match(xlsx, /## Results\nTrial\t\t42 \[=SUM\(A2:A5\)\]/)
  const pptx = render('pptx', {
    'ppt/slides/slide1.xml': '<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Findings</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:pPr><a:buChar char="*"/></a:pPr><a:r><a:t>Result</a:t></a:r></a:p></p:txBody></p:sp></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide3.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide3.xml': '<p:notes><a:p><a:r><a:t>Speaker notes</a:t></a:r></a:p></p:notes>',
  })
  assert.match(pptx, /## Slide 1\n### Findings\n- Result/)
  assert.match(pptx, /### Notes\nSpeaker notes/)
  const odt = render('odt', { 'content.xml': '<office:document><text:h text:outline-level="2">Methods</text:h><text:list><text:list-item><text:p>Item</text:p></text:list-item></text:list><text:p>Text<text:note><text:note-citation>1</text:note-citation><text:note-body><text:p>Footnote</text:p></text:note-body></text:note><office:annotation><dc:creator>Reviewer</dc:creator><text:p>Comment</text:p></office:annotation></text:p></office:document>' })
  assert.match(odt, /## Methods\n- Item/)
  assert.match(odt, /\[\^1\]: Footnote/)
  assert.match(odt, /\[comment, Reviewer\] Comment/)
  const ods = render('ods', { 'content.xml': '<office:document><table:table table:name="Totals"><table:table-row><table:table-cell office:value="42" table:formula="of:=SUM([.A2:.A5])"/><table:table-cell table:number-columns-repeated="2"><text:p>Cell</text:p></table:table-cell></table:table-row></table:table></office:document>' })
  assert.match(ods, /## Totals\n42 \[=SUM\(\[.A2:.A5\]\)\]\tCell\tCell/)
  console.log('PASS office structure: docx, xlsx relationships and sparse cells, pptx notes, odt, ods formulas')
} finally { rmSync(root, { recursive: true, force: true }) }
