---
name: slide-decks
description: Build, read, and revise PowerPoint decks (.pptx) — outline an existing deck, generate slides from a template's layouts with python-pptx, place text, tables, charts, and images on a consistent grid, and render to images or PDF for a visual check. Use when the request names slides, a deck, a presentation, or a .pptx; not for Word, spreadsheets, PDFs, or web pages.
when_to_use: The user wants a presentation created or edited, a deck summarised, slides restyled to a template, or speaker notes added.
argument-hint: "<path.pptx or 'new'> [what to do]"
---

# Slide decks

A deck is a sequence of slides, each built on a layout from the file's slide
masters. Respect the layouts: a deck whose slides all start from the right
layout stays consistent when the owner edits it; one built from free-floating
boxes falls apart on the first change.

## Read first

```bash
python3 scripts/deck_outline.py <file.pptx>     # slide titles, layout names, text, notes, pictures
python3 scripts/deck_outline.py --self-test
```

The outline shows every slide's title and body text, which layout it uses,
whether it carries speaker notes, and how many pictures it holds. Decide
from it whether you are adding slides to an existing design or building new.

## Build with python-pptx (1.0 as of August 2026)

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation("template.pptx")        # or Presentation() for the default 16:9
layout = next(l for l in prs.slide_layouts if l.name == "Title and Content")
slide = prs.slides.add_slide(layout)
slide.shapes.title.text = "Quarterly results"
body = slide.placeholders[1].text_frame
body.text = "Revenue up 12%"
p = body.add_paragraph(); p.text = "Costs flat"; p.level = 1
slide.notes_slide.notes_text_frame.text = "Lead with the revenue line."
prs.save("out.pptx")
```

- Pick layouts by name (`prs.slide_layouts` carries `.name`); print them once
  when the template is unfamiliar.
- Placeholders carry the template's fonts and positions; fill them instead of
  adding text boxes. Add a free shape only for content no placeholder fits.
- Tables: `slide.shapes.add_table(rows, cols, left, top, width, height)`;
  keep to six rows by four columns per slide, and right-align numbers.
- Charts: `slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, …,
  CategoryChartData())` keeps data editable in PowerPoint; an image of a
  chart does not.
- Images: `add_picture(path, left, top, width=…)` with one dimension so the
  aspect ratio holds. Position on the slide's grid (slide width
  `prs.slide_width`, in EMU; `Inches(1)` is 914400).

## Editing an existing deck

- Change text inside runs (`paragraph.runs[i].text`) to keep formatting;
  replacing `text_frame.text` resets it to the placeholder default.
- Reorder or delete slides through the XML slide id list
  (`prs.slides._sldIdLst`); python-pptx has no high-level call for it.
- Keep one idea per slide; split rather than shrink fonts below 18pt.

## Check it visually

Structure checks are not a visual check. Render with LibreOffice
(`soffice --headless --convert-to pdf deck.pptx`) and look at the pages, or
convert the PDF to PNGs (`pdftoppm -png -r 60 deck.pdf slide`) and inspect
for overflowing text, overlapping shapes, and empty placeholders before
handing the deck over.
