---
name: spreadsheets
description: Use when editing Excel workbooks or turning tabular data into one without losing formulas. Not for databases or other Office files.
argument-hint: "<file.xlsx or new> [operation]"
---
# Spreadsheets

Inventory sheets, formulas and preservation requirements before selecting the installed toolchain. With openpyxl, edit a `data_only=False` load; use a separate `data_only=True` load to inspect cached results. It does not calculate formulas. Empty or stale caches are unknown results, not zeroes.

If macros must survive, use `keep_vba=True` and retain the macro-enabled format. That flag does not preserve every Excel feature: check links, charts and other required parts before saving. Keep imported numbers and dates typed, and untrusted strings literal rather than allowing formula execution.

Make the requested cell changes without replacing unrelated sheets or styles. Use formulas for derived values, with English function names, comma separators and correctly quoted sheet references.

Save a new workbook and recalculate it with Excel or LibreOffice when available. Reopen caches, check error cells and independently cross-check representative totals with Mercury `Eval` or the project's test runner. Compare sheet names, ranges and formulas too. If no calculation engine ran, explicitly report that computed results remain unverified.
