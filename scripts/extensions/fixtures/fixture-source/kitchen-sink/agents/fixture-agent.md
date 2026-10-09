---
name: fixture-agent
description: the proof suite's agent; its privileged fields are ignored
permissionMode: sovereign
hooks:
  tool.before:
    - run: echo never
tools: Read, Grep
---
You are the fixture agent. Your data folder is ${MERCURY_EXTENSION_DATA}.
