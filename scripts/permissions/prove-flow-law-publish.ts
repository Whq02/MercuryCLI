#!/usr/bin/env bun
import { ROADS, allowedByFlow, asksWith, check, finish, j, openKit, refusedWith, section } from './flowLawKit.ts'

const kit = await openKit('flow-law-publish')

try {
  section('§1 item 3 asks: publishing and deploying, by name from the table, on every road')
  const asks: Array<[string, string]> = [
    ['npm publish', 'Flow asks before npm publish: it publishes a package.'],
    ['npm publish --access public --tag next', 'Flow asks before npm publish: it publishes a package.'],
    ['pnpm publish -r', 'Flow asks before pnpm publish: it publishes a package.'],
    ['yarn npm publish', 'Flow asks before yarn npm publish: it publishes a package.'],
    ['bun publish', 'Flow asks before bun publish: it publishes a package.'],
    ['npm unpublish pkg@1.0.0', 'Flow asks before npm unpublish: it publishes a package.'],
    ['cargo publish', 'Flow asks before cargo publish: it publishes a package.'],
    ['twine upload dist/*', 'Flow asks before twine upload: it publishes a package.'],
    ['python3 -m twine upload dist/*', 'Flow asks before twine upload: it publishes a package.'],
    ['poetry publish --build', 'Flow asks before poetry publish: it publishes a package.'],
    ['uv publish', 'Flow asks before uv publish: it publishes a package.'],
    ['gem push pkg-1.0.0.gem', 'Flow asks before gem push: it publishes a package.'],
    ['./gradlew publishToMavenCentral', 'Flow asks before gradlew publishToMavenCentral: it publishes a package.'],
    ['mvn deploy', 'Flow asks before mvn deploy: it publishes a package.'],
    ['dotnet nuget push pkg.nupkg', 'Flow asks before dotnet nuget push: it publishes a package.'],
    ['docker push ghcr.io/owner/image:1.0', 'Flow asks before docker push: it publishes an image.'],
    ['docker buildx build --push -t ghcr.io/owner/image .', 'Flow asks before docker buildx build --push: it publishes an image.'],
    ['docker compose push', 'Flow asks before docker compose push: it publishes an image.'],
    ['podman push img', 'Flow asks before podman push: it publishes an image.'],
    ['wrangler deploy', 'Flow asks before wrangler deploy: it deploys outside this machine.'],
    ['wrangler pages deploy dist', 'Flow asks before wrangler pages deploy: it deploys outside this machine.'],
    ['npx wrangler deploy', 'Flow asks before wrangler deploy: it deploys outside this machine.'],
    ['pnpm dlx wrangler deploy', 'Flow asks before wrangler deploy: it deploys outside this machine.'],
    ['vercel --prod', 'Flow asks before vercel --prod: it deploys outside this machine.'],
    ['vercel deploy --prebuilt', 'Flow asks before vercel deploy: it deploys outside this machine.'],
    ['npx vercel --prod', 'Flow asks before vercel --prod: it deploys outside this machine.'],
    ['netlify deploy --prod', 'Flow asks before netlify deploy: it deploys outside this machine.'],
    ['firebase deploy --only hosting', 'Flow asks before firebase deploy: it deploys outside this machine.'],
    ['fly deploy', 'Flow asks before fly deploy: it deploys outside this machine.'],
    ['flyctl deploy --remote-only', 'Flow asks before flyctl deploy: it deploys outside this machine.'],
    ['heroku container:push web', 'Flow asks before heroku container:push: it deploys outside this machine.'],
    ['railway up', 'Flow asks before railway up: it deploys outside this machine.'],
    ['eas update --branch main', 'Flow asks before eas update: it deploys outside this machine.'],
    ['supabase db push', 'Flow asks before supabase db push: it deploys outside this machine.'],
    ['kubectl apply -f deploy.yaml', 'Flow asks before kubectl apply: it changes a live cluster.'],
    ['kubectl delete pod web-0', 'Flow asks before kubectl delete: it changes a live cluster.'],
    ['kubectl rollout restart deployment/web', 'Flow asks before kubectl rollout: it changes a live cluster.'],
    ['helm upgrade --install web ./chart', 'Flow asks before helm upgrade: it changes a live cluster.'],
    ['terraform apply -auto-approve', 'Flow asks before terraform apply: it changes live infrastructure.'],
    ['terraform destroy', 'Flow asks before terraform destroy: it changes live infrastructure.'],
    ['tofu apply', 'Flow asks before tofu apply: it changes live infrastructure.'],
    ['pulumi up --yes', 'Flow asks before pulumi up: it changes live infrastructure.'],
    ['cdk deploy --all', 'Flow asks before cdk deploy: it changes live infrastructure.'],
    ['sam deploy --guided', 'Flow asks before sam deploy: it changes live infrastructure.'],
    ['serverless deploy', 'Flow asks before serverless deploy: it changes live infrastructure.'],
    ['aws cloudformation deploy --stack-name x --template-file t.yaml', 'Flow asks before aws cloudformation deploy: it changes live infrastructure.'],
    ['aws s3 sync build s3://bucket --delete', 'Flow asks before aws s3 sync: it changes live infrastructure.'],
    ['gcloud run services delete web --quiet', 'Flow asks before gcloud run services delete: it changes live infrastructure.'],
    ['gcloud run deploy web --image img', 'Flow asks before gcloud run deploy: it changes live infrastructure.'],
    ['az webapp up --name web', 'Flow asks before az webapp up: it changes live infrastructure.'],
    ['npm run build && npm publish', 'Flow asks before npm publish: it publishes a package.'],
    ['bash -c "cargo publish --allow-dirty"', 'Flow asks before cargo publish: it publishes a package.'],
  ]
  for (const [command, words] of asks) {
    for (const road of ROADS) {
      const outcome = await kit.decide(command, { road })
      const ok = road === 'prompt-less' ? refusedWith(outcome, words) : asksWith(outcome, words) && outcome.wrapper.decidedBy === 'flowLaw'
      check(`${road}: ${command} → ${road === 'prompt-less' ? 'refused with' : 'asks'} "${words}"`, ok, j(outcome.decision))
    }
  }

  section('§2 the neighbour that is not the item runs without a question: builds, tests, installs, plans, logs')
  for (const command of [
    'npm install', 'npm ci', 'npm install -D vitest', 'npm test', 'npm run build', 'npm run deploy:local', 'npm version patch', 'npm pack', 'npm view pkg version', 'npm publish --help | head -1', 'npm publish --dry-run',
    'pnpm add -D eslint', 'yarn', 'yarn add react', 'bun install', 'bun run build', 'pip install -r requirements.txt', 'python3 -m pip install requests', 'pipx install ruff', 'uv pip install httpx', 'brew install jq', 'apt-get install -y curl', 'cargo install cargo-watch',
    'cargo build --release', 'cargo test', 'cargo package --list', 'go build ./...', 'go test ./...', 'make', 'make test', 'twine check dist/*', 'poetry build', 'gem build pkg.gemspec',
    'docker build -t img .', 'docker buildx build -t img .', 'docker run --rm img npm test', 'docker compose up -d', 'docker compose build', 'docker images', 'docker logs web',
    'wrangler dev', 'wrangler whoami', 'vercel env ls', 'vercel link', 'vercel login', 'netlify dev', 'firebase emulators:start', 'fly status', 'fly logs', 'heroku logs --tail', 'railway logs',
    'kubectl get pods', 'kubectl describe pod web-0', 'kubectl logs web-0', 'kubectl config current-context', 'helm list', 'helm template web ./chart', 'terraform init', 'terraform plan', 'terraform validate', 'terraform fmt', 'tofu plan', 'pulumi preview', 'cdk synth', 'cdk diff', 'sam build', 'sam local invoke',
    'aws s3 ls s3://bucket', 'aws s3 cp s3://bucket/report.json ./report.json', 'aws sts get-caller-identity', 'gcloud auth list', 'gcloud run services list', 'az account show',
    'npx prettier --write .', 'npx tsc --noEmit', 'bunx eslint src', 'pnpm dlx envinfo', 'python3 -m pytest -q', 'python3 -m http.server 8000',
    './gradlew build', './gradlew test', 'mvn test', 'mvn package', 'dotnet build', 'dotnet test', 'eas build:list', 'supabase start', 'supabase db diff',
  ]) {
    for (const road of ROADS) {
      const outcome = await kit.decide(command, { road })
      check(`${road}: ${command} runs`, allowedByFlow(outcome), j(outcome.decision))
    }
  }

  section('§3 the operator\'s own rules outrank the item')
  const allowed = await kit.decide('npm publish', { rules: { allow: ['Bash(npm publish)'] } })
  check('an exact allow rule runs npm publish without a question', allowed.decision.behavior === 'allow', j(allowed.decision))
  const denied = await kit.decide('wrangler deploy', { rules: { deny: ['Bash(wrangler *)'] } })
  check('a deny rule refuses the deploy outright', denied.decision.behavior === 'deny' && denied.decision.decisionReason?.type === 'rule', j(denied.decision))

  section('§4 every row of the shipped table asks when spelled from its first command')
  const table = kit.FLOW_LAW[3] as { table: ReadonlyArray<{ commands: readonly string[]; forms: readonly string[]; why: string }> }
  let rows = 0
  for (const entry of table.table) {
    for (const form of entry.forms) {
      rows++
      const command = `${entry.commands[0]} ${form}${/^s3 (?:cp|mv|sync)$/.test(form) ? ' build s3://bucket' : ''}`.trim()
      const ask = await kit.flowShellAsk(command)
      check(`table row: ${command} asks as item 3 (${entry.why})`, ask?.item === 3 && ask.why === entry.why, j(ask))
    }
  }
  check(`the table carried ${rows} plain rows (more than 100)`, rows > 100)
  const sovereign = await kit.decide('npm publish', { mode: 'sovereign' })
  check('sovereign runs npm publish', sovereign.decision.behavior === 'allow', j(sovereign.decision))
} finally {
  kit.close()
}
finish('prove-flow-law-publish')
