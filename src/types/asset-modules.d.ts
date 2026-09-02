// Ambient declarations for non-code asset imports that the BUILD inlines but the
// strict typecheck floor can't resolve on its own. Type-only — emits nothing.
//
// The bundled-skill content modules (src/skills/bundled/*Content.ts) import their
// Markdown bodies directly (`import body from './skill/SKILL.md'`); the build
// inlines each .md file as a string and the import resolves to that string's
// default export. `moduleResolution: bundler` has no loader concept, so it
// reports every such import as TS2307. This wildcard ambient models the build's
// behaviour: any `*.md` import yields a string default export. The .md files DO
// exist on disk — this only teaches tsc how the build loads them; it has ZERO
// effect on the bundled artifact.
declare module '*.md' {
  const content: string;
  export default content;
}

// Bundled-skill REFERENCE files (scripts + text assets) inline the same way
// (build.ts 'text' loaders). Only NON-code-module extensions are declared here
// — a skill's .js/.cjs/.ts refs are embedded as string literals by the codegen
// (scripts/skills/gen-bundled.ts), never imported, so they need no declaration.
declare module '*.txt' { const content: string; export default content; }
declare module '*.sh' { const content: string; export default content; }
declare module '*.py' { const content: string; export default content; }
declare module '*.html' { const content: string; export default content; }
declare module '*.xml' { const content: string; export default content; }
declare module '*.dot' { const content: string; export default content; }
