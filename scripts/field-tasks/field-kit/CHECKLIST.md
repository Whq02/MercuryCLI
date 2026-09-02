# The field checklist — eight things to try

Work top to bottom; jot a line under each (there's space). "It worked" is
just as valuable as "it broke". Rough timings welcome but optional.

## 1. First paint
Start the kit (`pwsh -File .\Run-FieldKit.ps1`). Does Mercury's screen come
up clean — no garbled characters, no misplaced boxes, no flicker?

> notes:

## 2. Keyboard
Type a short instruction for the practice task (the launcher suggests one).
Do arrow keys, Backspace, Enter, and Esc all feel right? Anything swallowed
or doubled?

> notes:

## 3. Mouse
Click around: the input line, a message, any panel that looks clickable.
Select some text with the mouse and copy it. Did the right text copy?

> notes:

## 4. Resize
Drag the window narrower, then wider; maximize; restore. Does the layout
follow without artifacts or leftover fragments?

> notes:

## 5. A real little task
Let Mercury actually do the practice task (it's small and safe — a toy
ledger fix inside the kit's own folder). Did it finish? Did what it said
match what it did?

> notes:

## 6. Interrupt + resume
While Mercury is mid-answer, press Esc. Then ask it to continue. Did it
stop promptly, and pick the thread back up sanely?

> notes:

## 7. Quit + reopen
Quit Mercury (`/quit` or Ctrl+C twice), reopen it in the same folder, and
ask it what it was doing. Does the session history survive?

> notes:

## 8. The update flow
Run `mercury update`. Whatever happens — updated, already current, or an
error — copy the LAST few lines it printed here. (This is the one we most
need real-world eyes on.)

> notes:

---

Anything else that felt off — however small — belongs in ISSUE-TEMPLATE.md
(one copy per issue; two sentences is plenty).
