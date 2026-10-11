const DOCUMENTATION_ESTATES: Readonly<Record<string, readonly string[]>> = {
  protocols: ['agentskills.io', 'modelcontextprotocol.io'],
  languages: [
    'developer.mozilla.org', 'doc.rust-lang.org', 'docs.oracle.com', 'docs.python.org', 'docs.swift.org',
    'en.cppreference.com', 'go.dev', 'kotlinlang.org', 'learn.microsoft.com', 'pkg.go.dev', 'ruby-doc.org',
    'www.php.net', 'www.typescriptlang.org',
  ],
  web: [
    'angular.io', 'bun.sh', 'd3js.org', 'expressjs.com', 'getbootstrap.com', 'jestjs.io', 'jquery.com',
    'nextjs.org', 'nodejs.org', 'react.dev', 'reactrouter.com', 'redux.js.org', 'tailwindcss.com',
    'threejs.org', 'vuejs.org', 'webpack.js.org',
  ],
  python: [
    'docs.djangoproject.com', 'fastapi.tiangolo.com', 'flask.palletsprojects.com', 'jupyter.org',
    'matplotlib.org', 'numpy.org', 'pandas.pydata.org', 'pytorch.org', 'requests.readthedocs.io',
    'scikit-learn.org', 'www.tensorflow.org',
  ],
  platforms: [
    'asp.net', 'blazor.net', 'docs.spring.io', 'dotnet.microsoft.com', 'gradle.org', 'hibernate.org',
    'laravel.com', 'maven.apache.org', 'nuget.org', 'symfony.com', 'tomcat.apache.org', 'wordpress.org',
  ],
  mobile: ['developer.android.com', 'developer.apple.com', 'docs.flutter.dev', 'reactnative.dev'],
  data: ['huggingface.co', 'keras.io', 'spark.apache.org', 'www.kaggle.com'],
  storage: [
    'dev.mysql.com', 'graphql.org', 'prisma.io', 'redis.io', 'www.mongodb.com', 'www.postgresql.org',
    'www.sqlite.org',
  ],
  operations: [
    'cloud.google.com', 'devcenter.heroku.com', 'docs.aws.amazon.com', 'docs.netlify.com', 'kubernetes.io',
    'vercel.com/docs', 'www.ansible.com', 'www.docker.com', 'www.terraform.io',
  ],
  testing: ['cypress.io', 'selenium.dev'],
  games: ['docs.unity.com', 'docs.unrealengine.com'],
  servers: ['git-scm.com', 'httpd.apache.org', 'nginx.org'],
}

export const PREAPPROVED_HOSTS: ReadonlySet<string> = new Set(Object.values(DOCUMENTATION_ESTATES).flat())

type Reach = { whole: true } | { prefixes: string[] }

function reachTable(entries: Iterable<string>): ReadonlyMap<string, Reach> {
  const table = new Map<string, Reach>()
  for (const entry of entries) {
    const slash = entry.indexOf('/')
    const host = slash === -1 ? entry : entry.slice(0, slash)
    const known = table.get(host)
    if (slash === -1 || (known && 'whole' in known)) {
      table.set(host, { whole: true })
      continue
    }
    const prefixes = known ? known.prefixes : []
    prefixes.push(entry.slice(slash))
    table.set(host, { prefixes })
  }
  return table
}

const REACH = reachTable(PREAPPROVED_HOSTS)

const underPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`)

export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  const reach = REACH.get(hostname)
  if (!reach) return false
  return 'whole' in reach || reach.prefixes.some(prefix => underPrefix(pathname, prefix))
}
