export const PREAPPROVED_HOSTS: ReadonlySet<string> = new Set([
  'agentskills.io',
  'github.com/anthropics',
  'modelcontextprotocol.io',
  'platform.claude.com',
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
  'developer.android.com',
  'developer.apple.com',
  'docs.flutter.dev',
  'reactnative.dev',
  'huggingface.co',
  'keras.io',
  'spark.apache.org',
  'www.kaggle.com',
  'dev.mysql.com',
  'graphql.org',
  'prisma.io',
  'redis.io',
  'www.mongodb.com',
  'www.postgresql.org',
  'www.sqlite.org',
  'cloud.google.com',
  'devcenter.heroku.com',
  'docs.aws.amazon.com',
  'docs.netlify.com',
  'kubernetes.io',
  'vercel.com/docs',
  'www.ansible.com',
  'www.docker.com',
  'www.terraform.io',
  'cypress.io',
  'selenium.dev',
  'docs.unity.com',
  'docs.unrealengine.com',
  'git-scm.com',
  'httpd.apache.org',
  'nginx.org',
])

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

export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (hostOnlyEntries.has(hostname)) return true
  for (const entry of pathScopedEntries) {
    if (entry.host !== hostname) continue
    if (pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`)) return true
  }
  return false
}
