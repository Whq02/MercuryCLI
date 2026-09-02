/**
 * Code-documentation hosts WebFetch may reach without a permission prompt.
 * The tool normally only reaches domains the user supplied in some form;
 * the exception is code-related documentation.
 *
 * SECURITY: this list is ONLY for WebFetch's GET requests. The sandbox
 * network layer deliberately does NOT inherit it — arbitrary network access
 * (POST, uploads) to several of these hosts would enable data exfiltration;
 * some of them host user uploads.
 */
export const PREAPPROVED_HOSTS: ReadonlySet<string> = new Set([
  // The platform vendor and the protocol estate
  'agentskills.io',
  'github.com/anthropics',
  'modelcontextprotocol.io',
  'platform.claude.com',
  // Language references
  'developer.mozilla.org',
  'doc.rust-lang.org',
  'docs.oracle.com',
  'docs.python.org',
  'docs.swift.org',
  'en.cppreference.com',
  'go.dev',
  'kotlinlang.org',
  'learn.microsoft.com',
  'pkg.go.dev',
  'ruby-doc.org',
  'www.php.net',
  'www.typescriptlang.org',
  // Runtimes, web and JS
  'angular.io',
  'bun.sh',
  'd3js.org',
  'expressjs.com',
  'getbootstrap.com',
  'jestjs.io',
  'jquery.com',
  'nextjs.org',
  'nodejs.org',
  'react.dev',
  'reactrouter.com',
  'redux.js.org',
  'tailwindcss.com',
  'threejs.org',
  'vuejs.org',
  'webpack.js.org',
  // The Python stack
  'docs.djangoproject.com',
  'fastapi.tiangolo.com',
  'flask.palletsprojects.com',
  'jupyter.org',
  'matplotlib.org',
  'numpy.org',
  'pandas.pydata.org',
  'pytorch.org',
  'requests.readthedocs.io',
  'scikit-learn.org',
  'www.tensorflow.org',
  // JVM, PHP and .NET
  'asp.net',
  'blazor.net',
  'docs.spring.io',
  'dotnet.microsoft.com',
  'gradle.org',
  'hibernate.org',
  'laravel.com',
  'maven.apache.org',
  'nuget.org',
  'symfony.com',
  'tomcat.apache.org',
  'wordpress.org',
  // Mobile
  'developer.android.com',
  'developer.apple.com',
  'docs.flutter.dev',
  'reactnative.dev',
  // Data and ML
  'huggingface.co',
  'keras.io',
  'spark.apache.org',
  'www.kaggle.com',
  // Storage and query
  'dev.mysql.com',
  'graphql.org',
  'prisma.io',
  'redis.io',
  'www.mongodb.com',
  'www.postgresql.org',
  'www.sqlite.org',
  // Cloud and operations
  'cloud.google.com',
  'devcenter.heroku.com',
  'docs.aws.amazon.com',
  'docs.netlify.com',
  'kubernetes.io',
  'vercel.com/docs',
  'www.ansible.com',
  'www.docker.com',
  'www.terraform.io',
  // Testing
  'cypress.io',
  'selenium.dev',
  // Game engines
  'docs.unity.com',
  'docs.unrealengine.com',
  // Servers and tooling
  'git-scm.com',
  'httpd.apache.org',
  'nginx.org',
])

// Split once: the common hostname-only case stays a constant-time set
// lookup, and only the handful of path-scoped entries pay a prefix walk.
const hostOnlyEntries = new Set<string>()
const pathScopedEntries: Array<{ host: string; prefix: string }> = []
for (const entry of PREAPPROVED_HOSTS) {
  const slash = entry.indexOf('/')
  if (slash === -1) {
    hostOnlyEntries.add(entry)
  } else {
    pathScopedEntries.push({ host: entry.slice(0, slash), prefix: entry.slice(slash) })
  }
}

/**
 * Entries without a slash match the hostname exactly. A path-scoped entry
 * matches when the hostname matches AND the path equals the prefix exactly
 * or begins with it followed by a slash — the segment boundary is a
 * security requirement: an attacker-controlled sibling segment that merely
 * starts with the same characters must be rejected.
 */
export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (hostOnlyEntries.has(hostname)) return true
  for (const entry of pathScopedEntries) {
    if (entry.host !== hostname) continue
    if (pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`)) return true
  }
  return false
}
