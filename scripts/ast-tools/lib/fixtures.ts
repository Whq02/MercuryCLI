// ============================================================================
//  scripts/ast-tools/lib/fixtures.ts — one fixture per supported language:
//  a small file with a known structure, a meta-variable pattern that matches
//  it a known number of times, and (where a rewrite is natural) a rewrite
//  with the text the rewritten file must contain. The provers write these
//  into a disposable tree — never the calibration machine.
// ============================================================================
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface LanguageFixture {
  lang: string
  file: string
  good: string
  pattern: string
  /** Matches the pattern must find in `good`. */
  expect: number
  /** A capture key every match must carry (when the pattern captures). */
  capture?: string
  rewrite?: { rewrite: string; contains: string; inPlace?: boolean }
}

export const LANGUAGE_FIXTURES: LanguageFixture[] = [
  { lang: 'python', file: 'app.py', good: 'def greet(name):\n    print(name)\n    print("hi")\n', pattern: 'print($X)', expect: 2, capture: '$X', rewrite: { rewrite: 'log($X)', contains: 'log(name)', inPlace: true } },
  { lang: 'go', file: 'main.go', good: 'package main\n\nimport "fmt"\n\nfunc Greet() {\n\tfmt.Println("x")\n\tfmt.Println("y", 2)\n}\n', pattern: 'fmt.Println($$$A)', expect: 2, capture: '$$$A', rewrite: { rewrite: 'log.Println($$$A)', contains: 'log.Println("y", 2)', inPlace: true } },
  { lang: 'rust', file: 'lib.rs', good: 'fn greet() {\n    println!("{}", 1);\n    println!("{}", 2);\n}\n', pattern: 'println!($$$A)', expect: 2, capture: '$$$A', rewrite: { rewrite: 'eprintln!($$$A)', contains: 'eprintln!("{}", 2)', inPlace: true } },
  { lang: 'javascript', file: 'app.js', good: 'function greet(a) {\n  console.log(a)\n  console.log(a, 2)\n}\n', pattern: 'console.log($$$A)', expect: 2, capture: '$$$A', rewrite: { rewrite: 'logger.info($$$A)', contains: 'logger.info(a, 2)', inPlace: true } },
  { lang: 'typescript', file: 'util.ts', good: 'export function greet(a: number) {\n  console.log(a)\n}\nconst n = greet(1)\n', pattern: 'greet($X)', expect: 1, capture: '$X', rewrite: { rewrite: 'hello($X)', contains: 'const n = hello(1)', inPlace: true } },
  { lang: 'tsx', file: 'view.tsx', good: 'export function C() {\n  return <div>{greet(1)}</div>\n}\n', pattern: '<div>$$$C</div>', expect: 1, capture: '$$$C', rewrite: { rewrite: '<section>$$$C</section>', contains: '<section>{greet(1)}</section>' } },
  { lang: 'bash', file: 'run.sh', good: '#!/bin/bash\necho one\necho two three\nls\n', pattern: 'echo $$$A', expect: 2, capture: '$$$A', rewrite: { rewrite: 'printf $$$A', contains: 'printf two three' } },
  { lang: 'c-sharp', file: 'a.cs', good: 'class A { void M() { System.Console.WriteLine("x"); System.Console.WriteLine("y"); } }\n', pattern: 'System.Console.WriteLine($X)', expect: 2, capture: '$X', rewrite: { rewrite: 'Log.Write($X)', contains: 'Log.Write("y");' } },
  { lang: 'cpp', file: 'a.cpp', good: 'int main() {\n  printf("a");\n  printf("b");\n  return 0;\n}\n', pattern: 'printf($X)', expect: 2, capture: '$X', rewrite: { rewrite: 'puts($X)', contains: 'puts("b");', inPlace: true } },
  { lang: 'css', file: 'a.css', good: 'body { color: red; }\np { color: blue; }\n', pattern: '$S { color: $V; }', expect: 2, capture: '$V', rewrite: { rewrite: '$S { color: $V; margin: 0; }', contains: 'body { color: red; margin: 0; }' } },
  { lang: 'java', file: 'A.java', good: 'class A { void m() { System.out.println("x"); System.out.println("y"); } }\n', pattern: 'System.out.println($X)', expect: 2, capture: '$X', rewrite: { rewrite: 'log($X)', contains: 'log("y");' } },
  { lang: 'php', file: 'a.php', good: '<?php\nfunction greet() { echo "hi"; foo(1); foo(2); }\n', pattern: 'foo($X)', expect: 2, capture: '$X', rewrite: { rewrite: 'bar($X)', contains: 'bar(2);', inPlace: true } },
  { lang: 'ruby', file: 'a.rb', good: 'def greet\n  puts "x"\n  puts "y"\nend\n', pattern: 'puts $X', expect: 2, capture: '$X', rewrite: { rewrite: 'print $X', contains: 'print "y"', inPlace: true } },
  { lang: 'powershell', file: 'deploy.ps1', good: 'function Greet {\n  Write-Output "hi"\n  Write-Output "yo"\n}\n', pattern: 'Write-Output "hi"', expect: 1, rewrite: { rewrite: 'Write-Host "hi"', contains: 'Write-Host "hi"' } },
  { lang: 'ini', file: 'settings.ini', good: '[section]\nkey = value\nother = 2\n', pattern: 'key = $V', expect: 1, capture: '$V', rewrite: { rewrite: 'key = changed', contains: 'key = changed' } },
  { lang: 'regex', file: 'corpus.regex', good: 'a(b|c)*d\n', pattern: '(b|c)', expect: 1 },
  { lang: 'c', file: 'a.c', good: 'int main(void) {\n  printf("a");\n  printf("b");\n  return 0;\n}\n', pattern: 'printf($X)', expect: 2, capture: '$X', rewrite: { rewrite: 'puts($X)', contains: 'puts("b");', inPlace: true } },
  { lang: 'html', file: 'a.html', good: '<div class="a">hi</div>\n<div class="b">yo</div>\n', pattern: '<div class="a">$T</div>', expect: 1, capture: '$T', rewrite: { rewrite: '<div class="a">bye</div>', contains: '<div class="a">bye</div>' } },
  { lang: 'json', file: 'a.json', good: '{"a": 1, "b": {"a": 2}}\n', pattern: '{"a": $V}', expect: 1, capture: '$V', rewrite: { rewrite: '{"a": 3}', contains: '{"a": 3}' } },
  { lang: 'toml', file: 'a.toml', good: '[section]\nkey = "value"\nother = 1\n', pattern: 'key = $V', expect: 1, capture: '$V', rewrite: { rewrite: 'key = "changed"', contains: 'key = "changed"' } },
  { lang: 'kotlin', file: 'a.kt', good: 'fun greet() {\n    println("hi")\n    println("yo")\n}\n', pattern: 'println($X)', expect: 2, capture: '$X', rewrite: { rewrite: 'log($X)', contains: 'log("yo")', inPlace: true } },
  { lang: 'swift', file: 'a.swift', good: 'func greet() {\n    print("hi")\n    print("yo")\n}\n', pattern: 'print($X)', expect: 2, capture: '$X', rewrite: { rewrite: 'debugPrint($X)', contains: 'debugPrint("yo")', inPlace: true } },
  { lang: 'vue', file: 'a.vue', good: '<template>\n  <div>hi</div>\n  <div>yo</div>\n</template>\n', pattern: '<div>hi</div>', expect: 1, rewrite: { rewrite: '<div>bye</div>', contains: '<div>bye</div>' } },
]

/** Write every fixture under `root/<lang>/<file>`; returns the paths. */
export function writeLanguageFixtures(root: string): Map<string, string> {
  const paths = new Map<string, string>()
  for (const f of LANGUAGE_FIXTURES) {
    const abs = join(root, f.lang, f.file)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, f.good)
    paths.set(f.lang, abs)
  }
  return paths
}

/** The three-file rename fixture (the benchmark shape): a function declared
 *  in one file and called from two more, in TypeScript, plus a Python and a
 *  Go caller so the same pattern spans languages. */
export function writeRenameFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'records.ts'),
    `// Record helpers.\nexport function normalizeRecord(record: { label: string; value: number }) {\n  // trim the label, keep the value\n  const label = record.label.trim()\n  return { label, value: record.value }\n}\n`,
  )
  writeFileSync(
    join(root, 'src', 'stats.ts'),
    `import { normalizeRecord } from './records'\n\nexport function summarize(records: Array<{ label: string; value: number }>) {\n  const rows = records.map(r => normalizeRecord(r))\n  return rows.length\n}\n`,
  )
  writeFileSync(
    join(root, 'src', 'report.ts'),
    `import { normalizeRecord } from './records'\n\nexport function firstLabel(record: { label: string; value: number }) {\n  if (record.value > 0) {\n    return normalizeRecord(record).label\n  }\n  return ''\n}\n`,
  )
  writeFileSync(join(root, 'README.md'), '# fixture\n\nnormalizeRecord(x) in prose is not code.\n')
}
