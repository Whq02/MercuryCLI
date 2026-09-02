# {{SOURCE_NAME}}

A source of Mercury extensions.

## What this source offers

{{EXTENSION_LINES}}

## Add it

```sh
mercury extensions add {{SOURCE_URL}}
```

Then open `/extensions` in Mercury (or run `mercury extensions list --source {{SOURCE_NAME}}`)
to see what it offers, press `i` on an extension to read exactly what it will run on your
machine and what it adds to the model's reach, and approve it. Nothing runs until you approve.

## What each extension needs

{{NEEDS_LINES}}

## Updates

Refresh the source (`u` on its row, or `mercury extensions check {{SOURCE_NAME}}`) to learn of a
newer version; `U` on the extension's row (or `mercury extensions update <name>@{{SOURCE_NAME}}`)
applies it. Mercury never updates on its own.

## Maintained by

{{MAINTAINER}}

## Licence

{{LICENSE}}
