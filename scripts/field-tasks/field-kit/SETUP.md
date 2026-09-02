# Mercury field kit — five-minute setup (Windows)

Thanks for helping test Mercury in the field. Everything here runs with just
three things you already have:

- **Windows Terminal** (the one with tabs — comes with Windows 11)
- **PowerShell 7** (`pwsh`) — if `pwsh --version` says 7-point-anything,
  you're set
- **Your installed Mercury** (`mercury --version` should answer)

Nothing in this kit reads your projects, your browser, or your files. The
kit works entirely inside its own folder plus your Mercury installation.

## 1. Unpack

Unzip `mercury-field-kit.zip` anywhere you like — Desktop is fine. You get:

```
mercury-field-kit/
  SETUP.md          this file
  CHECKLIST.md      the eight things to try (10-15 minutes)
  task/             one small self-contained practice task for Mercury
  Run-FieldKit.ps1  the launcher (starts Mercury on the practice task)
  Collect-Report.ps1  gathers YOUR notes + the kit's own logs into one file
  ISSUE-TEMPLATE.md what to write down when something feels wrong
```

## 2. Open the kit in Windows Terminal

Right-click the `mercury-field-kit` folder → "Open in Terminal", then:

```powershell
pwsh -File .\Run-FieldKit.ps1
```

The launcher checks your Mercury version, copies the practice task into a
fresh working folder, and starts Mercury in it. From there, follow
`CHECKLIST.md` top to bottom.

## 3. When you're done (or something broke)

```powershell
pwsh -File .\Collect-Report.ps1
```

This shows you EVERYTHING it wants to include — one item at a time, and you
can say no to any of it — then writes `field-report-<date>.zip` next to the
kit. Send that zip back. It contains only: your checklist notes, the kit's
own logs, Mercury's version numbers, and your Windows/terminal versions.
Never your files, never your projects, never anything you said no to.
