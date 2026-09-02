---
name: spreadsheets
description: Read, build, and repair Excel workbooks (.xlsx) — inspect sheets and headers, load data with openpyxl or pandas, write formulas that recalculate, apply number formats and conditional styles, and verify the result opens cleanly. Use when the request names a spreadsheet, workbook, .xlsx, or .csv-to-Excel task; not for Word, slides, PDFs, or SQL databases.
when_to_use: The user wants a workbook created from data, an existing .xlsx analysed or changed, formulas added or fixed, or a CSV turned into a formatted sheet.
argument-hint: "<path.xlsx or 'new'> [what to do]"
---

# Spreadsheets

Look before writing: a workbook's sheets, headers, and whether it carries
formulas decide the tool. Keep formulas as formulas (so the workbook stays
live for its owner), keep data typed (numbers as numbers, dates as dates),
and verify by reopening.

## Read first

```bash
python3 scripts/sheet_summary.py <file.xlsx>      # sheets, dimensions, header row, formula count
python3 scripts/sheet_summary.py --self-test
```

For values and analysis:

```python
import openpyxl                                     # openpyxl 3.1 (August 2026)
wb = openpyxl.load_workbook("data.xlsx", data_only=True)   # cached values
ws = wb["Sales"]
rows = list(ws.iter_rows(min_row=2, values_only=True))
```

`data_only=True` returns the last values Excel saved; a workbook written by a
library and never opened in Excel has no cached values, so formulas read as
`None`. Load without `data_only` to see the formula text itself. For heavy
analysis, `pandas.read_excel(path, sheet_name=None)` gives one frame per
sheet.

## Write

- Build with openpyxl: `ws.append(row)` for data, `ws["B2"] = "=SUM(B3:B20)"`
  for formulas (English function names, comma separators, the `=` prefix).
- Set `number_format` per column (`"#,##0.00"`, `"0.0%"`, `"yyyy-mm-dd"`)
  rather than formatting values as strings.
- Freeze the header (`ws.freeze_panes = "A2"`), set column widths from the
  longest header, bold the header row, and add an autofilter over the data
  range so the sheet is usable on open.
- Cross-sheet references use the quoted sheet name: `='Q1 Data'!B2`.
- Conditional formatting, data validation, charts, and named ranges all exist
  in openpyxl; prefer them over hand-painted cells so the intent survives
  edits.
- With pandas, `df.to_excel(writer, sheet_name=..., index=False)` inside
  `pd.ExcelWriter(path, engine="openpyxl")`, then reopen with openpyxl to
  format.

## Formulas that recalculate

openpyxl writes formula text but computes nothing. When the owner needs
values present without opening Excel, recalculate headlessly with LibreOffice
(`soffice --headless --convert-to xlsx --outdir out/ file.xlsx`) and reload
with `data_only=True` to check for `#REF!`, `#NAME?`, `#DIV/0!`. A formula
that errors on recalculation is a defect, not a formatting note.

## Verify

- Reopen the saved file; confirm sheet names, header row, row count, and a
  spot check of three computed cells against an independent calculation.
- Dates are real dates (the cell's `is_date` is true), not text.
- No merged cells inside data regions; no formulas referencing empty ranges.
- Large workbooks: write with `openpyxl.Workbook(write_only=True)` and read
  with `read_only=True` to stay within memory.
