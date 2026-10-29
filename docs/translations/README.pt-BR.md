[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, pacote npm `mercury-tech-cli`) executa agentes de programação com IA no seu terminal, dentro dos seus próprios repositórios git no macOS, Linux e Windows.

Site: [mercury-cli.ai](https://mercury-cli.ai) · Repositório: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

Um agente lê e edita arquivos, executa comandos de shell, percorre testes e depuradores passo a passo, e verifica os resultados. Você escolhe o provedor do modelo, o modelo e o que o agente pode fazer:

- **Concourse multissessão e worktrees isolados:** execute várias sessões lado a lado no Session Concourse (`/concourse`) e delegue trabalho paralelo a crewmates de provedores diferentes (`Crewmate`), em checkouts isolados de `git worktree` com reservas de arquivos do projeto, para que os agentes paralelos não se sobrescrevam.
- **20 provedores de modelos, `/llmhost` e `/localsetup`:** mantenha os 20 provedores conectados ao mesmo tempo (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI) e troque de provedor e de modelo durante o chat. Abra `/llmhost` para escolher um modelo, verificar a quantização dele, a divisão `conversations × context` e o nível de raciocínio, e executá-lo em uma GPU alugada (Runpod, Vast.ai ou Lambda), no seu próprio computador (`mercury host`) ou em um servidor existente. Ou execute `/localsetup` para instalar ou conectar o Ollama junto com o LM Studio, o vLLM e o llama.cpp.
- **Memória de projeto RAG híbrida do Mneme:** usa um modelo de embeddings semânticos BGE de 118 MB que roda no próprio dispositivo (`bge-base-en-v1.5`), com ranking de palavras BM25, rastreamento de citações, regras fixadas literais, contexto de inicialização ciente da branch, verificações de contradição na gravação, notas de passagem entre sessões e o grafo de navegador de `/memory page`.
- **Ferramentas de compilador, AST e depuração DAP:** conecta a inteligência de código LSP e refatorações com pré-visualização (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), busca e reescrita estrutural de AST com tree-sitter em 23 linguagens (`AstSearch`, `AstEdit`), um depurador integrado de Debug Adapter Protocol (`Debug`) que usa `debugpy`, `js-debug`, `lldb`, `gdb` e `dlv` para avançar passo a passo por testes que falham em Python, Node, Go e Rust, e células `Eval` persistentes de Python e JavaScript.
- **`WebSearch` sem chave e `WebFetch` em markdown:** pesquisa pela busca nativa do provedor, por chaves do Brave ou do Tavily, por APIs oficiais (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), por SearXNG e por DuckDuckGo sem chave, e obtém documentação pública em markdown dentro de um orçamento de 38.000 caracteres por chamada.
- **Controle de desktop, voz com Whisper, agendamento com Saturn e integrações com editores:** controla aplicativos de desktop (`Computer`), transcreve o ditado por voz de pressionar para falar no próprio dispositivo com o Whisper (`/voice`), agenda sessões recorrentes ou únicas com o Saturn (`/saturn`) e se conecta ao VS Code pelo Agent Client Protocol (`mercury acp`), junto com Unity, Blender, Godot e Aseprite.
- **Geração de vídeo (`Video`):** envia prompts e arquivos de referência do projeto a um gerador da MiniMax configurado ([docs/VIDEO.md](../VIDEO.md)) e salva no seu projeto o MP4 gerado e, opcionalmente, um quadro PNG de pré-visualização de 1 segundo.

O Mercury é usado para desenvolver o próprio Mercury, com várias sessões e modelos em tarefas longas. Acompanhar esse trabalho é a parte difícil: o que ainda está rodando, o que mudou e o que precisa de uma decisão. Cada sessão escreve a própria nota de passagem ao terminar, e a sessão seguinte lê essa nota uma vez na inicialização, junto com as minhas regras fixadas, o que evita que o contexto se contamine entre sessões.

![Um prompt para o coordenador no painel de sessões inicia duas sessões, cada uma no seu próprio worktree; uma pergunta antes de editar, e ambas terminam com as alterações prontas para revisão](../media/session-board-stream.gif)

O Mercury é de código aberto sob a Apache License 2.0, assim como os SDKs em [sdk/](../../sdk/) e [sdk-py/](../../sdk-py/).

## Instalação

Os arquivos de release estão disponíveis para Macs com Apple silicon e Intel, Linux x64 e arm64, e Windows x64 e arm64. Instale o `git` separadamente; cada arquivo inclui o Node e o ripgrep, então não é preciso instalar o Node à parte.

Escolha um método de instalação:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS e Linux (x64 e arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 e arm64), no PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS e Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` é o mesmo pacote
mise use -g npm:mercury-tech-cli                   # mise, pelo pacote do npm
```

Os endereços de instalação mantêm contagens aproximadas de requisições de script por origem e por dia UTC (instalações concluídas não são contadas); o contador não armazena endereço IP, string de user-agent nem cookie.

Abra um terminal novo, ou execute a linha `export PATH=…` que o instalador de shell imprime, e depois execute `mercury --version` para verificar e `mercury` dentro de um repositório para iniciar a [primeira execução](#a-primeira-execução). No Windows PowerShell, e depois de uma instalação via Homebrew, npm, bun ou mise, o `mercury` funciona no mesmo terminal.

<details>
<summary>Caminhos de instalação, atualizações e verificação de releases</summary>

### Diferenças entre os métodos de instalação

Os instaladores de shell e PowerShell buscam a release mais recente para a sua plataforma, conferem o SHA-256 dela com `SHA256SUMS.txt`, descompactam e executam o comando `mercury install` do próprio arquivo.

Homebrew e o pacote npm são cada um fixados em uma release específica e são republicados após cada tag, então podem ficar atrás da release mais recente. Os comandos do Homebrew usam o nome completo do tap `Whq02/mercury/mercury` (o `mercury` sozinho no `homebrew-core` é outro programa). O pacote npm, `mercury-tech-cli`, é um launcher que baixa a release fixada; o mise instala esse mesmo pacote. `mercury install --uninstall` remove a release instalada e o shim do comando, mas mantém sua configuração e suas sessões (também execute `npm uninstall -g mercury-tech-cli` se você instalou o launcher do npm).

A instalação do Mercury é local do usuário e não exige acesso de administrador. Você pode executar um comando de instalação de novo sem risco.

### Caminhos de instalação

As versões de release ficam no diretório de configuração, em `~/.mercury/versions/<version>` (`%USERPROFILE%\.mercury\versions` no Windows). O comando `mercury` é instalado em `~/.local/bin` no macOS e no Linux, ou em `%LOCALAPPDATA%\Mercury\bin` no Windows.

`mercury install` adiciona o diretório do comando ao PATH uma única vez: uma linha protegida no arquivo de inicialização do seu shell, ou uma entrada no PATH do usuário do Windows. Um terminal novo aplica a mudança automaticamente.

### Atualizações

Use `mercury update` com qualquer método de instalação.

Em uma instalação feita com o instalador de shell ou PowerShell, ou com `mercury install`, ele atualiza o Mercury no próprio lugar. `--check` verifica se há atualizações, `--status` informa o estado da atualização e `--rollback` volta para a versão anterior, que continua no disco.

No Homebrew, ele pergunta antes de executar `brew upgrade Whq02/mercury/mercury`. A resposta padrão é não; digite `y` para aprovar. O Mercury transmite a saída do comando e verifica a versão instalada depois. Use `--yes` para pular a pergunta em scripts.

O launcher do npm usa o mesmo layout de releases dos instaladores e delega cada execução para a release instalada. Por isso, `mercury update` atualiza uma instalação do npm no próprio lugar, pelo canal de atualização do próprio Mercury. `npm update -g mercury-tech-cli` altera apenas a release que o pacote instala na primeira execução. Isso também vale ao usar o mise.

`--check` lê a mesma lista de releases para todos os métodos de instalação e informa como atualizar a sua. Quando há uma atualização disponível, a tela inicial mostra `vX.Y.Z available · mercury update` uma vez no canto inferior direito, e o chat mostra o mesmo aviso até você atualizar. Defina `MERCURY_UPDATE_NOTICE=0` para ocultar os dois.

Requisições de instalação e atualização buscam a lista pública de releases e os arquivos de forma anônima. Você pode executá-las sem conta nem token. Se uma requisição anônima for recusada, o Mercury consulta a GitHub CLI (`gh`) conectada.

Depois de uma atualização, o Mercury verifica se o comando no seu PATH aponta para a instalação atualizada. Se outra instalação tiver prioridade, ou se o comando atualizado não estiver no PATH, ele explica o problema e a correção. `mercury health` informa o mesmo problema.

### Verificação de releases

Antes de ativar uma release, o Mercury confere o arquivo dela com `SHA256SUMS.txt`. Ele também exige um conteúdo assinado pela chave de release do Mercury presente na lista de confiança incorporada ao programa antes de preparar a atualização. Uma assinatura rejeitada deixa a instalação ativa inalterada.

Use `--allow-unsigned` para aceitar um conteúdo não assinado. O Mercury continua rejeitando chaves de assinatura desconhecidas, blocos de assinatura malformados e conteúdo adulterado. O resultado do comando e o registro local dele mostram que você permitiu um conteúdo não assinado.

Os arquivos de versão são assinados. Execute `mercury health` para inspecionar a assinatura da versão instalada.

Um arquivo sem assinatura de versão é marcado como não assinado. A instalação e a atualização o recusam, a menos que você passe `--allow-unsigned`.

[docs/TRUST.md](../TRUST.md) explica os resultados da verificação e como conferir um arquivo manualmente. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) trata da verificação na inicialização.

### Notas sobre plataformas

Há arquivos de release para todas as plataformas listadas acima. Qualquer outra máquina compila a partir do código-fonte.

Há arquivos de versão disponíveis para Mac Intel.

</details>

## Requisitos

Os arquivos de release incluem o Node 24 LTS. O launcher, o `mercury install` e o `mercury update` usam esse runtime empacotado; o `git` é o único requisito separado para a própria release.

Para compilar a partir do código-fonte, você precisa de:

- **Node 24 LTS**, na faixa suportada `>=24.20.0 <25`. O `.node-version` fixa o patch usado nas compilações e incluído nos arquivos de release.
- **bun 1.3.x** para a compilação. Ele não vem empacotado com as releases.
- **git**. No Windows, execute o PowerShell 7 dentro do Windows Terminal ou do terminal do VS Code. Veja [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

O mínimo do Node inclui a correção do nodejs/node#56645. Abaixo de 24.20.0, comandos `run` headless que chamam uma ferramenta são abortados ao sair no Windows.

Os launchers escolhem o Node nesta ordem: o binário indicado em `MERCURY_NODE`, o runtime empacotado e, depois, uma instalação compatível do Node no PATH. Se o runtime estiver ausente, o launcher informa um erro.

### Shells do Windows

Os arquivos de release incluem o motor de shell compatível com bash do Mercury (`brush`), e no Windows ele atende a ferramenta Bash por padrão: encontra um programa `.cmd` ou `.bat`, como o `npm`, pelo nome simples via PATHEXT, repassa `%VAR%` e `^` a um arquivo em lote sem alterações, executa um programa indicado por caminho relativo depois de `cd` e mantém o estado do shell entre as chamadas. O `bash.exe` do Git para Windows não é necessário; quando ele está instalado, `MERCURY_SHELL_ENGINE=system`, ou `system` em `/config` na opção Shell engine, faz a ferramenta Bash usar somente o `bash.exe`.

Leia a linha `shell` da verificação de saúde para ver qual shell está ativo e por quê: o motor empacotado (o padrão no Windows, ou ativado pela fixação ou pela configuração), ou o Git Bash, quando o motor foi desligado ou o pacote dele está ausente.

No macOS e no Linux, o shell do sistema é o padrão; defina `MERCURY_SHELL_ENGINE=brush`, ou escolha `brush` em `/config`, na opção Shell engine, para rodar a ferramenta Bash no motor empacotado também ali, com estado de shell persistente.

Uma compilação a partir do código-fonte sem o pacote do motor nem o Git para Windows ainda inicia, mas a ferramenta Bash fica indisponível. A ferramenta PowerShell continua disponível, e o diagnóstico `shell` explica como restaurar o suporte ao Bash.

## Compilar a partir do código-fonte

O Mercury compila com bun e roda no Node 24 LTS. Instale [os requisitos para compilar a partir do código-fonte](#requisitos), incluindo o bun 1.3.x:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS e Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, no PowerShell 7
bun --version                                      # 1.3.x
```

Depois, em um clone deste repositório:

```sh
bun run setup                      # uma vez; bun install + os pacotes incluídos
bun run build.ts                   # grava dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Suporte a terminais

A interface em tela cheia precisa de um TTY real, mas não tem tamanho mínimo de terminal. O layout completo começa em 100 colunas por 26 linhas; janelas menores usam um layout compacto.

O Mercury usa cor de 24 bits quando o terminal anuncia suporte por meio de `COLORTERM=truecolor` ou é reconhecido como iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal ou VS Code. Outros terminais usam 256 cores, incluindo o Terminal da Apple no macOS 15 e anteriores.

A linha Terminal color da verificação de saúde informa a profundidade detectada e o motivo. Defina `MERCURY_TRUECOLOR=1` para um terminal que suporta cor verdadeira mas não a anuncia, ou `MERCURY_TRUECOLOR=0` para forçar 256 cores.

### Componentes opcionais

O `setup` baixa os pacotes de capacidades incluídos: pyright, debugpy, js-debug, gramáticas extras, o runtime do Node da plataforma e o brush. Se um download falhar, esse pacote é ignorado e a compilação e as ferramentas afetadas informam o componente ausente. Executar apenas `bun install` gera uma compilação sem esses pacotes.

Para compilar o suporte a voz, execute `setup` com o Rust instalado. Isso compila `native/voice`. Adicione o cmake para compilar também o `native/whisper`. Com o Rust instalado, o `setup` também compila o addon do driver de desktop (`native/desktop`), pelo qual a ferramenta `Computer` opera. Com o Rust instalado, o `setup` também compila o addon local de embeddings (`native/embed`, `bun run scripts/vendor/build-embed.ts`) e baixa o modelo BGE de 118 MB (`bun run scripts/vendor/fetch-embed-models.ts --default`); sem o cargo, o pacote é ignorado, o setup informa isso e a busca de memória do Mneme passa a fazer apenas correspondência de palavras. Cada arquivo de release traz o pacote de embeddings compilado para a sua plataforma; no Linux e no Windows, a matemática roda em um kernel vetorizado, de modo que um Recall por significado leva cerca de um décimo de segundo (algumas centésimas no macOS, que usa o Accelerate). Se uma compilação nativa não tiver as ferramentas necessárias, o setup a ignora e a verificação de saúde informa o addon ausente. O motor de shell do Windows também é compilado na sua máquina, porque o upstream não tem binário para Windows.

Veja [Shells do Windows](#shells-do-windows) e [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) para o motor de shell `brush`.

A compilação grava apenas em `dist/`. A configuração e as sessões ficam em `~/.mercury`, ou no diretório definido por `MERCURY_CONFIG_DIR`, e são criadas na primeira execução. No Windows, execute `node dist\mercury.mjs` diretamente.

### Instalar uma compilação a partir do código-fonte como comando

`scripts/ops/deploy-runtime.sh` publica uma compilação de árvore limpa em uma pasta nova `<config home>/runtime/builds/<build>` e aponta `runtime/current` para ela (`runtime/dist` é o nome antigo do mesmo link). `scripts/ops/deploy-launcher.sh` instala o launcher em `<config home>/bin/mercury`. Adicione esse diretório ao PATH; no zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

O launcher para com um erro se o runtime estiver ausente. Ele não troca para outra compilação. A seleção do Node segue a ordem descrita em [Requisitos](#requisitos). Para uma instalação de release, execute `mercury install` ou `mercury update`, que deixam os checkouts do código-fonte inalterados; veja [Atualizações](#atualizações).

[AGENTS.md](../../AGENTS.md) é o guia breve de compilação e execução. [BUILD-NOTES.md](../../BUILD-NOTES.md) trata da compilação com mais detalhes.

## A primeira execução

Na sua primeira execução interativa, escolha uma aparência e depois faça login em um provedor. A tela mostra uma prévia das mudanças de tema enquanto você navega. True Black é o padrão; as outras opções são o tema escuro oasis e Black and white, que não aplica cor alguma: usa a própria tinta do terminal sobre o próprio fundo, do jeito que o Mercury aparece em um terminal sem cor. Você pode mudar isso depois com `/appearance`.

Você também pode escolher "sign in later" para explorar sem conectar uma conta. Quando uma chave de provedor no seu ambiente já conecta um provedor, a etapa de login não é solicitada. Em seguida, a etapa Guardrails lembra você de conferir as edições e os comandos do Mercury, e de que o que ele lê pode trazer instruções para o modelo. Em um terminal que o Mercury sabe configurar (Terminal.app, a família VS Code, Alacritty, Zed), uma etapa Terminal keys pode configurar atalhos de nova linha nas configurações do próprio terminal (no Terminal.app do macOS, ela define `Option+Enter` para nova linha e silencia o sino do terminal em todos os perfis, o que passa a valer depois de reiniciar o Terminal.app; na família VS Code, no Alacritty e no Zed, ela grava `Shift+Enter` para nova linha). Ela fica desativada, a menos que você a escolha, e uma cópia de segurança é mantida.

Em seguida, o Mercury pergunta se você confia na pasta que abriu. Nada solicitado por uma configuração do workspace é executado antes de você conceder essa confiança. A concessão abrange o repositório inteiro; recusar encerra o Mercury. Veja [docs/TRUST.md](../TRUST.md).

Uma inicialização interativa normal abre a tela inicial. Ela tem dez entradas de menu; Continue Last Session aparece somente depois que você tem histórico de sessões:

- **New Session in \<folder\>** inicia uma sessão nova na pasta atual.
- **Continue Last Session** volta ao seu chat mais recente.
- **Boot Menu** configura as sessões futuras, incluindo motion, crewmates e workflows.
- **MCPs & Skills** escolhe o que a próxima sessão carrega. Veja [docs/KIT.md](../KIT.md).
- **Agents** cria e edita agentes.
- **Health Check** verifica a instalação.
- **Saturn Scheduler** agenda sessões. Veja [docs/SATURN.md](../SATURN.md).
- **Logins** conecta contas de provedores.
- **Session Concourse** abre a lista de sessões do projeto atual.
- **Sessions · Projects** permite escolher uma sessão ou um repositório.

As entradas do menu abrem sobre a tela inicial, e `Esc` volta à entrada que você selecionou. A lista de sessões abre em uma tela separada, também acessível com `Shift+→`. Um argumento de prompt, `--continue` ou `--resume` leva você direto ao chat.

### Motion, crewmates e workflows

A seção Performance do Boot Menu inclui uma configuração Motion: `auto`, `full`, `reduced` ou `off`. Ela controla a animação em repouso da interface e também está disponível em `/config`.

Em Agents, os interruptores Crewmates e Workflows determinam se as sessões novas recebem as ferramentas Crewmate e Workflow. Desligar um interruptor remove a ferramenta correspondente; tentativas de iniciar esse tipo de trabalho devolvem a mesma explicação. Dentro de uma sessão, `/crewmates on|off` e `/workflows on|off` mudam a configuração no próximo limite de turno.

## O ciclo diário: Session Concourse, git worktrees e crewmates

### Iniciar uma sessão e isolar worktrees

Pressione `Enter` em New Session para criar uma sessão na pasta atual com o seu modelo padrão. O Mercury abre o chat e, ao mesmo tempo, adiciona a sessão à lista de sessões. Ele mantém um processo pronto por trás do menu para reduzir o trabalho de inicialização.

Iniciar outra sessão não interrompe a anterior. Você pode deixar uma tarefa rodando e trabalhar em outra coisa. Inicie com `--worktree [name]` (ou peça um `worktree` no chat para executar `EnterWorktree`) para dar a uma sessão a sua própria branch e o seu próprio checkout em `.mercury/worktrees/`. Crewmates paralelos também podem rodar em worktrees isolados e coordenar arquivos compartilhados com reservas de arquivos do projeto; veja [O que inclui](#o-que-inclui-memória-rag-do-mneme-lsp-ast-de-23-linguagens-depurador-dap-busca-web-e-integrações) e [docs/CREW.md](../CREW.md).

### Trabalhar no chat

Descreva o trabalho em linguagem natural. O agente lê, edita, executa e verifica o código sob o modo de permissões que você escolheu. As chamadas de ferramentas aparecem enquanto são executadas, como cartões compactos ou com a saída completa. Escolha a exibição em `/config`, em Tool output; a configuração fica salva para as próximas execuções.

Use `/model` e `/effort` para ajustar a sessão. `/permissions` controla o que pode rodar sem aprovação e o que precisa perguntar antes.

Revise as alterações com `/diff`, por origem, arquivo e hunk. `! <command>` executa um comando de shell no chat, com as últimas linhas da saída em tempo real. `/runs` mostra os shells e os crewmates em execução (`/tasks` abre o mesmo painel), e `/crewmates` abre a visão Crew ao vivo. Entre turnos, `/clear` salva o chat atual e abre uma sessão nova, e `/restart` move o chat para uma compilação do Mercury recém-instalada. `/title` dá nome ao chat, e `/help` lista os comandos disponíveis.

### Mover-se entre telas

`Shift+←` e `Shift+→` movem entre as telas disponíveis no momento. Uma execução nova tem a tela inicial e a lista de sessões. A tela de chat é adicionada quando uma sessão recebe o foco e removida quando o último chat é fechado. As dicas de teclas mostram apenas os movimentos disponíveis.

Fechar todos os chats leva você de volta à tela inicial. Use `--chat` para ter só a tela inicial e o chat, sem a lista de sessões. `--concourse-off` salva essa preferência para as próximas execuções; `--concourse-on` ou `/config` a ativa novamente.

### Gerenciar sessões no Session Concourse

Abra a lista de sessões com `/concourse` ou com `Shift+→` a partir da tela inicial. Ela mostra primeiro as sessões em execução do projeto atual, seguidas dos chats salvos que não estão em execução, do mais recente para o mais antigo.

Cada sessão em execução tem uma célula NOW com a atividade atual. Selecione uma linha e pressione `Enter` para voltar ao chat enquanto as outras sessões continuam rodando. Uma sessão que falhou permanece na lista como NEEDS YOU, com o motivo, até que você a libere.

[docs/SESSIONS.md](../SESSIONS.md) cobre o ciclo de vida das sessões.

## Provedores e modelos: logins, `/localsetup` e `/llmhost`

Use `/logins` para conectar um provedor. Ele abre o mesmo catálogo de login usado durante a configuração. `/accounts` gerencia depois os slots de provedores conectados.

- **OpenAI:** assinatura do ChatGPT ou chave de API.
- **Anthropic:** assinatura do Claude, login no Console ou chave de API.
- **OpenRouter:** acesso ao catálogo por OAuth ou chave de API; as requisições de modelo recusam coleta de dados e exigem todos os parâmetros desde o início. `/config → OpenRouter routing policy` define as opções de fallback e de retenção zero de dados; escolha open para relaxar a política e deixar o roteamento com o OpenRouter.
- **Google Gemini:** Sign in with Google, uma chave de API ou o seu próprio cliente OAuth. Sign in with Google executa o Gemini com a cota do plano que a conta Google tem (uma conta gratuita, Google AI Pro ou Google AI Ultra) pelo cliente Antigravity da própria Google: o prompt, os esquemas das ferramentas e os resultados das ferramentas são enviados ao endpoint Code Assist da Google sob esse cliente e a conta conectada, e `/model` lista o conjunto de modelos que a Google oferece à conta. Uma chave de API ou o seu próprio cliente OAuth cobra de um projeto do Cloud.
- **Hugging Face:** login por código de dispositivo ou token do Hub.
- **Kimi (Moonshot):** login por código de dispositivo ou chave de API.
- **GLM (Z.AI):** uma chave de assinatura do GLM Coding Plan ou uma chave de API geral de pagamento por uso. `/logins zai` salva qualquer uma das duas e registra o plano; `ZAI_API_KEY` também funciona, com `ZAI_KEY_PLAN=coding|general` indicando o plano (se não estiver definido, o Mercury lê o plano na própria lista de modelos da chave).
- **DeepSeek:** uma chave de API da plataforma DeepSeek (`/logins deepseek` ou `DEEPSEEK_API_KEY`).
- **xAI (Grok):** entre com a sua assinatura do Grok (SuperGrok / X Premium) ou cole uma chave de API por `/logins xai`.
- **Meta (Muse):** Sign in with Meta (uma assinatura do Muse Code, com um código de dispositivo no navegador) ou uma chave de Model API de pagamento por uso. Sign in with Meta troca o código de dispositivo pelos endpoints OIDC da Meta (`https://auth.meta.com/oidc/device/authorization/` e `/oidc/device/token/`) sob o id de cliente público do Muse Code, envia o token da conta resultante uma única vez para `https://api.meta.ai/muse-code/key` para gerar a chave de API da assinatura (e em leituras limitadas de `/usage`, para a faixa do plano e as janelas de uso), e envia somente a chave gerada em cada requisição de modelo para `https://api.meta.ai/v1`. Uma chave de Model API colada, ou `MODEL_API_KEY` / `META_API_KEY`, cobra por uso.

- **Qwen:** uma chave da QwenCloud (Token Plan ou pagamento por uso) ou uma chave do Alibaba Cloud Model Studio (pagamento por uso, Token Plan ou Coding Plan), verificada no próprio endpoint antes de ser salva; uma chave de plano lista os modelos do plano, com o Qwen3.8 Max primeiro.
- **MiniMax:** uma chave do Open Platform ou uma chave de assinatura do M Plan.
- **Together AI** e **Cohere:** chave de API.
- **Groq**, **Cerebras** e **Fireworks AI:** chave de API; a chave de qualquer família também pode vir de um comando indicado em `credentials.keyCommands.<family>`.

Mistral, Nous Portal e OpenCode Zen também se conectam por `/logins`, totalizando 20 famílias de provedores com login. Servidores de modelos locais (Ollama, LM Studio, vLLM e llama.cpp) e endpoints personalizados compatíveis com OpenAI funcionam sem login de provedor. Execute `/localsetup` para instalar ou iniciar o Ollama, baixar um modelo que caiba na sua memória, definir a janela de contexto dele ou conectar um servidor LM Studio, vLLM ou llama.cpp que já esteja em execução ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Cada provedor usa o próprio protocolo, as próprias credenciais e o próprio tratamento de erros, e as requisições nunca passam para outro provedor. Veja [docs/ENGINES.md](../ENGINES.md).

`/llmhost` lista os modelos que você pode hospedar e mostra onde cada um pode rodar agora: em uma GPU alugada da Runpod, da Vast.ai ou da Lambda, no seu próprio computador ou em um computador SSH salvo (`mercury host`), ou em um servidor de modelos existente. Cada página de modelo mostra as opções de quantização, como o orçamento de memória da GPU se divide entre conversas paralelas (`conversations × context`) e o nível de raciocínio padrão (que `/effort` muda por requisição). Aluguéis de GPU exigem uma confirmação explícita do preço por hora, e a configuração continua em segundo plano se você fechar a janela pop-up. Na Runpod, você também pode ajustar qualidade, divisões de contexto e raciocínio antes de alugar ou em um pod em execução (`Tune`), manter os pesos em um volume de carregamento rápido e definir alertas de estoque com intervalo de 5 segundos. Os aluguéis na Vast.ai e na Lambda são novidade na 1.0.0-beta.40 e foram verificados com as APIs publicadas pelos fornecedores, usando fixtures (não foram feitas execuções reais de aluguel). Veja [docs/LLM-HOST.md](../LLM-HOST.md).

Novas sessões usam o provedor conectado mais recentemente e o modelo mais novo disponível para essa conta. Modelos que a conta não consegue acessar são ignorados. Se esse provedor não tiver nenhum modelo utilizável, o Mercury verifica o próximo provedor conectado mais recentemente. Essa escolha acontece quando a sessão começa; uma requisição que falha em uma sessão existente permanece com o seu provedor.

`/model` explica a seleção. Uma palavra de família escolhe o modelo mais novo dessa família: `/model grok`, `/model deepseek`, `/model kimi` ou `/model glm`. Sem nenhum provedor conectado, a tela inicial e o `/model` direcionam você para `/logins`. `/defaultprovider` permite tornar explicitamente um provedor a escolha mais recente.

O acesso aos provedores continua sujeito aos termos e à disponibilidade próprios de cada provedor. A licença do Mercury não os substitui.

## A CLI headless: `mercury run`, Docker e o runner JSON-RPC

A mesma compilação roda sem a interface interativa. `node dist/mercury.mjs --help` lista todas as opções.

`mercury run "<prompt>"` executa um prompt sem interface de terminal:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` imprime a resposta; o motivo de um turno que falhou vai para o stderr.
- `json` imprime a última linha `outcome` como um único objeto JSON.
- `rows` escreve um objeto JSON por linha: `session`, depois um `turn` e as suas linhas `text`, `reasoning`, `tool_call`, `tool_result` e `step`, terminando em `outcome`. Esperas, progresso das ferramentas, tarefas em segundo plano e avisos têm as suas próprias linhas. Toda linha traz `seq`, `timestamp` e `session_id`; as linhas de um turno também trazem o número `turn` dele. `seq` numera o fluxo desta execução a partir de 1; `turn` conta os turnos da sessão, então uma execução que continua uma conversa salva (`-c`, `-r`, `--fork`) numera o seu turno depois dos que já existem nela, e a linha `session` indica em `resume_of` a conversa que ela continua.

Os tipos de linha de saída, pelo campo `type`:

- `session`: a linha de abertura: `version`, `build` (os primeiros doze caracteres hexadecimais da árvore a partir da qual o pacote foi compilado, como `mercury daemon status` os mostra; ausente quando não há um manifesto ao lado do pacote), `resume_of` (em uma execução continuada, o id da sessão da conversa que ela continua; é o mesmo que `session_id`, exceto quando a execução foi bifurcada), `cwd`, `model`, `mode`, além de `tools`, `mcp_servers`, `commands`, `agents`, `skills` e `extensions` da sessão, e `tools_withheld` (presente quando uma regra de negação retém uma ferramenta pelo nome simples: em cada entrada, `tool`, `rule` e `source`).
- `turn`: um turno `started` ou `waiting`, com o seu `turn_id`; `model`, `message_ids` e a contagem de `agents`, quando conhecida.
- `text`: um bloco de texto já concluído: `message_id`, `block`, `text` e a sua `phase` (`commentary` ou `final_answer`).
- `reasoning`: um bloco de raciocínio já concluído: `message_id`, `block`, `text`, ou `redacted: true`.
- `tool_call`: uma chamada de ferramenta: `call_id`, `tool`, `input`, com o seu `message_id` e `block`.
- `tool_result`: o resultado da chamada: `call_id`, `status` (`ok`, `error`, `aborted` ou `refused`) e `output`. Uma chamada que o modelo formou tão mal que foi recusada antes da execução (uma ferramenta desconhecida, argumentos que não são JSON válido ou que não se encaixam no esquema da ferramenta) ainda recebe o seu par: uma linha `tool_call` com os argumentos como chegaram (`{}` quando não eram um objeto) e uma linha `tool_result` com status `refused`, cujo `output` é o motivo; em seguida vem o `notice` de correção. Essa chamada nunca foi executada e não é uma negação.
- `tool_update`: progresso de uma ferramenta em execução: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` ou `eval`) e qualquer um de `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` e `total` que a chamada informar. Uma chamada de shell ou de PowerShell emite um tick conforme a saída chega (um comando que não imprime nada nunca emite ticks); uma chamada MCP, quando o seu servidor informa progresso; uma chamada Eval, enquanto a sua célula roda; nenhuma outra ferramenta emite ticks; uma chamada de Browser ou de Crewmate fica em silêncio até o resultado.
- `step`: uma chamada ao modelo da thread principal: `message_id`, `model`, `usage`, e `stop` quando o modelo informou por que parou.
- `outcome`: o resultado do turno, descrito abaixo.
- `close`: a nota deixada para a próxima sessão ao fechar: `state` (`stored`, `skipped` ou `none`), `note_chars` e o `usage` das chamadas ao modelo que a escreveram, para que quem somar o uso de todas as linhas chegue ao do resultado. Com o prompt dado como argumento, a nota é pedida dentro do último turno e `close` vem antes do `outcome` desse turno; com `--input rows`, ela vem depois do último `outcome`, quando o stdin é fechado.
- `wait`: uma espera pelo modelo: `state` (`first_byte`, `retry`, `silence`, `loading` ou `done`) com os números que esse estado traz, como `since_ms`, `attempt` e `of`, `delay_ms`, `reason` e `http_status`.
- `heartbeat`: o fluxo do modelo deu sinal de vida depois de pelo menos um segundo sem um evento analisado: chegaram bytes que não produziram nenhuma linha. A linha não traz mais nada e aparece no máximo uma vez por segundo; a frequência depende do formato de streaming do provedor, então um fluxo que nunca faz pausas entre eventos não emite nenhuma.
- `compaction`: uma compactação `started`, em `progress` ou `ended`: `trigger` (`manual`, `auto` ou `overflow`), `stage`, `fill`, `summary_tokens` e, no fim, `exit` (`landed`, `cancelled` ou `failed`).
- `mode`: o modo de permissões foi alterado: `mode`.
- `rate_limit`: o estado de limite do provedor: `status` (`allowed`, `warning` ou `rejected`), `window`, `resets_at`, `utilization` e os campos de excedente.
- `task`: uma tarefa em segundo plano `started`, em `progress` ou `ended`: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` ou `stopped`) e `output_file`, conforme forem se tornando conhecidos.
- `notice`: um `warning` ou `error` para quem lê: `text`, e um `code`, como `input_refused`.
- `command_output`: a saída de um comando slash que nunca chegou ao modelo: `command` e `text`.
- `mission_updated`: o registro de tarefas da sessão mudou; leia-o de novo.
- `samples_updated`: as amostras da sessão mudaram; leia-as de novo.

Com `--partial` e `--format rows`, somam-se as linhas `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` e `retracted`. Os deltas pertencem a `message_id` e `block`; uma linha `retracted` retira os deltas daquela mensagem. A linha de texto ou de ferramenta já concluída é o valor completo.

O resultado traz `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` e `denials`, com `answer` quando concluído e `error` (`message`, `class`, `detail` opcional) quando falha. `stop`, `api_ms`, `cost_usd`, a saída `structured` solicitada e `notices` são incluídos quando disponíveis. `wall_ms` é o tempo decorrido do turno. `api_ms` é a soma das durações de cada requisição ao modelo feita no turno (incluindo as novas tentativas e as requisições dos crewmates que rodaram em paralelo com a thread principal), por isso pode ser maior que `wall_ms` quando as requisições se sobrepõem. `cost_usd` é o valor em USD das requisições precificadas do turno, qualquer que seja o status: uma requisição que o Mercury não consegue precificar (sem tarifa registrada, sem custo informado na resposta) não soma nada e deixa o seu modelo listado em `models` sem um `cost_usd` próprio; o campo só fica ausente quando nada do turno foi precificado. Em um login por assinatura do Claude, as requisições da Anthropic não têm preço em dólar, então nem elas nem a linha trazem `cost_usd`; o uso permanece. O resumo de uso traz `input_tokens` (incluindo os tokens em cache), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` e, quando informado, `reasoning_output_tokens`, somados na thread principal e nos crewmates. `models` detalha o uso de tokens por modelo. `steps` conta apenas as chamadas ao modelo do agente principal; as chamadas feitas pelos crewmates aparecem como linhas `step` próprias, marcadas com `parent_call_id`.

O status é `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` ou `loop_stopped`. Uma execução com `--max-time` (em segundos, ou `10m`, `1h`) termina com `time_limit` no passo seguinte, assim que o tempo se esgota; a chamada ao modelo ou a rodada de ferramentas em andamento não é interrompida. Uma execução concluída sai com código 0, os demais resultados com código 1, e um erro de uso com código 2. SIGINT e SIGTERM saem com 130 e 143 depois que o resultado do turno interrompido é gravado. Uma chamada de ferramenta recusada aparece em `denials`. Quando a recusa foi um pedido de permissão que ninguém pôde responder (uma execução sem host em um modo que pergunta, `--mode dontAsk`, ou um pedido de um host que expirou) e nenhuma chamada de ferramenta posterior no turno tem sucesso, a execução fica `blocked`: a resposta é mantida, `error` indica a ferramenta e como retomar (`--allowed-tools`, outro `--mode` ou um host que responda aos pedidos), e a execução sai com código 1. Se uma chamada de ferramenta posterior no mesmo turno tiver sucesso, o turno se recupera e termina como `completed` (código 0) com um `notice` de aviso (`"<Tool> was not approved; the run continued with other tools."`). Uma recusa que você respondeu (por uma regra de negação, um hook ou um host que disse não) mantém concluído um turno concluído. Uma chamada `AskUserQuestion` sem resposta também faz a execução terminar como `blocked`, com a pergunta citada em `error`; o Mercury lê o resultado a partir das perguntas registradas na execução, nunca do texto da resposta, então uma pergunta escrita apenas na resposta termina como `completed`. Um comando slash desconhecido resulta em `refused`, com a mesma frase que a tela interativa mostra (`Unknown command: /name · /help lists commands`), e sai com código 1.

`--input rows` exige `--format rows` e lê um objeto de entrada por linha:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Os tipos de entrada são `prompt` com `content` (blocos de texto ou de texto e imagem), `shell` com `command` e `note` com `to` (um id de agente) e `content`. Cada um aceita um `id` opcional; as linhas de prompt e de shell também aceitam `priority` (`now`, `next` ou `later`), `sent_at` e `origin`. Um formato de entrada recusado gera um `notice` com o código `input_refused`; JSON malformado encerra a execução. Essas linhas levam apenas entrada; as respostas de permissão usam o protocolo do runner descrito abaixo.

Use `mercury run -` ou envie texto por um pipe para o `mercury run` para ler o prompt inteiro a partir do stdin. Ao lado de um argumento de prompt, o texto recebido pelo pipe é acrescentado como contexto delimitado: o pipe é lido até ser fechado ou ficar um segundo sem dados, então um fluxo que continua entregando dados é lido até o fim, e um pipe que fica aberto e sem dados não prende a execução. Sem prompt e com um terminal no stdin, `run` imprime o seu uso e sai com código 2.

`--mode <mode>` seleciona a postura de permissões. `--sovereign` executa sem pedidos de permissão, e `--allow-sovereign` deixa essa postura disponível para uma troca posterior. A política de permissões e as regras de negação continuam valendo. Um usuário root que entra no modo sovereign recebe um aviso no stderr; a execução continua.

Use `-c` para continuar a conversa mais recente, `-r` para retomar por ID, título ou seletor, `-w` para executar em um worktree gerenciado, e `--lean` para uma sessão mínima. Um `run` não tem host para responder aos pedidos de permissão: as regras de permissão e o modo dele decidem o que pode rodar, e uma chamada que ainda precise de aprovação é negada.

### A imagem headless

O `Dockerfile` na raiz do repositório gera uma imagem Linux x64 para CI e servidores. O ponto de entrada dela é `mercury` e o verbo padrão é `run`, de modo que a imagem executa um prompt sobre uma árvore montada e sai com o código da execução:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

A imagem traz o pacote, o runtime do Node 24 dela (no `PATH`), as ferramentas incluídas de busca, shell, depurador, linguagens e imagens, o `git` e o armazenamento de certificados; não há tela de entrada nem fluxo de login. Ela roda com o usuário não root `mercury`, com o diretório de configuração dentro do contêiner (`MERCURY_CONFIG_DIR`), e `/work` é o diretório de trabalho. Cor e mouse seguem a detecção de terminal do próprio produto, e `--user 0` executa como root, com o único aviso de sovereign descrito acima.

Uma chave de provedor chega como variável de ambiente, com as mesmas grafias que o produto lê em todos os lugares: `ANTHROPIC_API_KEY` ou `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` ou `GOOGLE_API_KEY`, `XAI_API_KEY` (e `XAI_MANAGEMENT_API_KEY` para o seu medidor de uso), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (e `MISTRAL_ADMIN_API_KEY` para o seu medidor da organização), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` ou `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` ou `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` ou `META_API_KEY`, `MERCURY_COMPAT_API_KEY` para um endpoint personalizado compatível com OpenAI e `MERCURY_LOCAL_API_KEY` para um servidor local. Sem chave, a execução é recusada em uma linha e sai com código 1. `docker run -i … mercury run -` lê o prompt a partir do stdin.

### Hospedar uma sessão

`mercury runner` serve uma sessão a um host pelo stdio: JSON-RPC 2.0, uma mensagem por linha. O host envia `initialize` primeiro e aguarda a resposta antes de enviar trabalho:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

O nome e a versão do host viajam em `host`; `capabilities` declara `holds_asks`, `elicitation` e `partial_rows`. Cada `id` de requisição é um inteiro positivo: uma requisição cujo `id` seja qualquer outra coisa recebe a resposta `-32600` com `id: null`, então numere as requisições a partir de 1.

`queue/add` aceita o mesmo objeto de prompt, shell ou note da entrada de linhas descrita acima. A saída chega em notificações `row`. `session/facts` lê o estado da sessão; `session/set_mode` muda o modo de permissões imediatamente; `session/set_model` e `session/set_effort` mudam o modelo e o esforço, e uma mudança feita enquanto um turno roda fica retida até o fim do turno: a resposta traz `at: "turn_end"` e, em seguida, `session/applied` a anuncia. `turn/interrupt` interrompe um turno; feche o stdin para encerrar a sessão.

Os pedidos de permissão chegam como `permission/request`, com `kind: "tool"` ou `kind: "network"`. O host responde com `outcome: "allow"` ou `outcome: "deny"`; um allow pode trazer um `input` editado e `rules` de permissão. Um pedido retirado envia `$/cancel_request` com o seu `request_id`. `holds_asks` dá ao host a titularidade do cronômetro do pedido. Um pedido de MCP usa `elicitation/request` somente quando o host declara `elicitation`; caso contrário, recebe a resposta `cancel`.

Um método desconhecido recebe `-32601`, parâmetros inválidos recebem `-32602`, um `id` que não é um inteiro positivo recebe `-32600`, e uma requisição anterior à inicialização recebe `-32002`. Uma recusa por regra é `-32010`, com uma frase em `error.message` e um motivo em `error.data.kind`, como `mode`, `model`, `effort` ou `claim`. O runner responde a uma linha malformada com `-32700` e continua; três linhas malformadas seguidas o encerram.

### Outros comandos

Entre os comandos disponíveis estão:

- **`mercury health`**: relatório de diagnóstico, também chamado de certificado de saúde. `--json` retorna o relatório completo, `--deep` executa o inventário profundo e `--fix` executa as correções guiadas.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: faz login (`login [<family>]`), lista as famílias de provedores (`list`), verifica se uma conta está conectada (`status [<family>]`), desconecta (`logout [<family>]`) ou gera um token de longa duração da Anthropic (`mint`).
- **`mercury models [--json]`**: imprime os modelos que as contas conectadas acessam (os mesmos dados de `mercury://models`).
- **`mercury mcp`**: gerencia servidores MCP com `add`, `import`, `list`, `get`, `remove`, `trust-reset` e `serve`.
- **`mercury extensions`**: instala extensões e gerencia as suas fontes. Ações: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` e `scaffold`.
- **`mercury roster`**: lista o inventário de agentes.
- **`mercury usage`**: imprime a linha compacta de números que a tela `/usage` mostra; `--json` imprime a leitura completa: as janelas de cada provedor conectado, com uso e reinício, os números e os créditos que ele informou, cada um com a sua fonte e idade, e o gasto da sessão por modelo, lido da mesma forma que a tela o lê (o leitor de cada provedor conectado é amostrado uma vez, como ao abrir a tela).
- **`mercury daemon run|status|stop|restart`**: executa, inspeciona, para ou reinicia o daemon em segundo plano. Os assentos de sessão dele são processos filhos de `mercury runner`; o daemon envia os prompts deles e hospeda os pedidos de permissão deles.
- **`mercury sessions list`** (também `mercury sessions` sozinho): lista as sessões salvas deste projeto, da mais recente para a mais antiga: o id, quando foi gravada pela última vez, o tamanho, `live` quando o daemon a hospeda agora, e o título ou o primeiro prompt; `--all` lê todos os projetos, e `--limit <n>` limita a lista. O id é o que `mercury --resume <id>` reabre e o que `sessions delete` remove.
- **`mercury sessions delete <id>`**: exclui de propósito uma sessão salva (a transcrição dela e os registros mantidos ao lado: recibos e snapshot de retomada), depois de uma pergunta; `--yes` pula a pergunta em scripts. Uma sessão que o daemon hospeda agora é recusada, e um id desconhecido é recusado com uma dica para o inventário (`/sessions` dentro do Mercury). Sessões salvas nunca são excluídas por conta própria.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: executa um computador local ou SSH como servidor de modelos para todas as sessões que compartilham o diretório de configuração (`compat/box-<name>/<model>`), usando um banco local de pesos verificado ou um download confirmado. Veja [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** e **`mercury lsp install <server>`**: o catálogo de servidores de linguagem, com cada servidor instalado (com o seu binário) ou ausente (com a sua instrução de instalação); `install` mostra a instrução de instalação de um servidor, pergunta, executa exatamente essa instrução (`--yes` pula a pergunta em scripts) e informa onde o binário foi parar. Um servidor desconhecido é recusado com o inventário. O Mercury nunca instala um servidor de linguagem por conta própria; abrir um arquivo só inicia um servidor que já esteja instalado.
- **`mercury acp`**: serve um editor pelo Agent Client Protocol, com um processo runner filho para cada sessão. `mercury bridge install` instala a extensão do VS Code; `mercury bridge status` verifica; `mercury bridge uninstall` a remove.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: gerencia jobs do motor para o projeto Godot no diretório atual. O Mercury executa as suítes nos seus próprios workers headless a partir de uma cópia congelada do projeto. O serviço inclui um gate de compilação, capturas, estatísticas de quadros, perfis concluídos, acesso à fila de jobs, cancelamento e resultados por ID. Veja [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: exibe uma imagem no terminal.
- **`mercury install`** e **`mercury update`** (alias `upgrade`): instalam ou atualizam os arquivos de release; com `--json`, o documento vai para o stdout independentemente do veredito, e o código de saída indica se houve falha. Veja [Instalação](#instalação).
- **`mercury version`** e **`mercury help [command]`**: imprimem a linha de versão ou uma página de ajuda, o mesmo que `--version` e `--help`; nenhum dos dois inicia uma sessão.

## O que inclui: memória RAG do Mneme, LSP, AST de 23 linguagens, depurador DAP, busca web e integrações

- **Memória de projeto RAG híbrida do Mneme.** O Mneme vem ativado por padrão e guarda os fatos de cada projeto em páginas de tópicos em markdown simples (`Retain`, `Recall`, `Reflect`, `Correct`). O Recall combina um modelo de embeddings semânticos BGE de 118 MB que roda no próprio dispositivo (`bge-base-en-v1.5` `q8_0`, MIT, incluído em cada arquivo de release e compilado para a sua plataforma; veja [Componentes opcionais](#componentes-opcionais)) com ranking de palavras BM25 com stemming, ponderação por recência e rastreamento de citações por fusão por rank recíproco (`k = 60`). As regras fixadas (`pin: true`) são carregadas textualmente na seção de regras fixadas e só mudam com a sua palavra. Na inicialização da sessão, o Mercury pontua os fatos não fixados e as notas anteriores em relação à sua branch atual, aos arquivos tocados recentemente e à nota de passagem da última sessão, dentro de uma cota de inicialização própria (`memory.startLimit`, 4.000 caracteres por padrão). As verificações de contradição na gravação detectam inversões de polaridade, negações e troca de números antes que um fato conflitante seja salvo. Cada sessão escreve, ao sair, uma nota de passagem com as próprias palavras para a página de entrada da sessão seguinte, além de uma entrada opcional no diário da sessão. `/memory` abre a central de memória, e `/memory page` desenha a biblioteca no seu navegador como um grafo de nós e arestas. Veja [docs/MNEME.md](../MNEME.md).
- **Inteligência de código LSP, reescritas AST de 23 linguagens, depurador DAP e células `Eval`.** Leituras ancoradas e edições atômicas de vários arquivos (`ChangeSet`); consultas ao servidor de linguagem (`LspRead`) e refatorações com pré-visualização seguida de aplicação (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); busca e reescrita sobre a árvore sintática (`AstSearch`, `AstEdit`) com as metavariáveis `$NAME` e `$$$NAME` em 23 gramáticas nos arquivos de release (16 em todo build de `bun install` mais 7 no pacote de gramáticas); células de código persistentes em Python (`python3`) e JavaScript (módulo ES do Node) (`Eval`); e um depurador de Debug Adapter Protocol (`Debug`) que comanda `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, o adaptador de depuração do SDK do Dart, `kotlin-debug-adapter`, o adaptador de depuração do elixir-ls e o Godot. A ferramenta `Test`, com a operação `debug`, leva um teste que falhou em Python (`pytest`, `unittest`), JavaScript/TypeScript (`node-test`, `vitest`, `jest`), Go (`go test`) ou Rust (`cargo test`) direto para uma sessão de `Debug`, onde é possível avançar passo a passo. Veja [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [transações de alteração](../CHANGE-TRANSACTIONS.md), [padrões estruturais](../STRUCTURAL-PATTERNS.md), [células de código](../EVAL.md) e [o depurador](../DEBUGGER.md).
- **`WebSearch` sem chave e `WebFetch` em markdown.** `WebSearch` percorre uma única cascata: primeiro a busca nativa ao vivo do provedor, quando o modelo da sessão a suporta (`ProviderSearch`); depois as chaves salvas do Brave ou do Tavily; depois as APIs oficiais escolhidas pelo formato da consulta (Stack Exchange, npm, PyPI, crates.io, busca de código do GitHub, Hacker News Algolia, Wikipedia); depois as APIs JSON do SearXNG configuradas (`MERCURY_SEARCH_SEARXNG_INSTANCES`); e, por último, o scraping de páginas do DuckDuckGo sem chave (ativado por padrão; desative em `/config` ou com `MERCURY_SEARCH_KEYLESS=0`). Cada resposta fica abaixo de 2.000 tokens e informa qual fonte respondeu. `WebFetch` lê páginas públicas como markdown, com as palavras da própria página, dentro de um orçamento de 38.000 caracteres por chamada (uma página que precisa de navegador é lida pelo leitor hospedado `r.jina.ai`, a menos que `MERCURY_FETCH_READER=0` esteja definido, e um endereço de rede privada nunca é enviado a ele). Veja [docs/ENGINES.md](../ENGINES.md).
- **Agentes, crewmates entre provedores (`Crewmate`), worktrees e reservas de arquivos.** Dois agentes integrados (`mercury-crew` para trabalho delegado de qualquer tipo e `mercury-scout` para reconhecimento somente leitura) ficam ao lado das definições de agente que você cria em `/agents`. Inicie crewmates com qualquer provedor conectado, isole o trabalho paralelo em checkouts do `git worktree` (`isolation: "worktree"`), coordene arquivos compartilhados com reservas de arquivos do projeto dentro do próprio processo (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), e direcione ou retome crewmates por nome ou id com `SendMessage` e `ResumeCrewmate`. Acompanhe crewmates e execuções de workflow em `/crewmates` e `/runs`. Veja [docs/CREW.md](../CREW.md).
- **Controle de desktop.** Ativado por padrão quando o driver nativo de desktop está disponível. A ferramenta `Computer` faz capturas de tela e controla o mouse e o teclado no aplicativo em primeiro plano. O Mercury verifica o aplicativo pelo nome e pela identidade antes de agir, pede aprovação, a menos que as suas regras de permissão, a concessão da sessão, a configuração de acesso ou o modo de permissão já permitam a ação, para com `Esc`, deixa apenas uma sessão controlar o desktop por vez e mantém as capturas de tela fora do arquivo de conversa salvo. Defina `MERCURY_COMPUTER_USE=0` para remover a ferramenta. Veja [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Ditado por voz com Whisper no próprio dispositivo (`/voice`).** `/voice on` baixa, no primeiro uso, o modelo de fala em inglês de 60 MB (`base.en-q5_1`), verifica o seu digest SHA-256 e ativa o ditado; `/voice off` o desativa. Mantenha a barra de espaço pressionada por 1 s para falar e solte para parar, ou execute `/voice` sozinho para iniciar e parar uma gravação enquanto a voz estiver ativa. O Whisper transcreve no próprio dispositivo, então o áudio de voz nunca sai da máquina, e `MERCURY_WHISPER_MODEL` escolhe `tiny.en-q5_1`, `small.en-q5_1`, o modelo multilíngue `base-q5_1` ou um arquivo `.gguf` local. Veja [docs/VOICE.md](../VOICE.md).
- **Agendador cron e de sessões Saturn (`/saturn`).** Agende um prompt para uma sessão existente (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) ou agende uma sessão nova para começar em um horário definido. Os agendamentos podem rodar uma vez ou se repetir. Veja [docs/SATURN.md](../SATURN.md).
- **Integrações com VS Code (ACP), Unity, Blender, Godot e Aseprite.** `mercury acp` se conecta a editores que suportam o Agent Client Protocol. A extensão do VS Code (`mercury bridge install`) executa o Mercury dentro do editor por esse protocolo: chat, sessões, agentes, artefatos e revisões, com a seleção e os diagnósticos do editor acompanhando cada prompt. Integrações separadas e opcionais se conectam aos editores Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) e Godot (`MERCURY_GODOT_TOOLS=1`) que estiverem em execução, e há acesso em lote ao Aseprite (`MERCURY_ASEPRITE=1`). Veja [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) e [Aseprite](../ASEPRITE-BRIDGE.md).
- **Extensões.** Cada extensão tem um único manifesto. Adicione fontes a partir de uma URL do git, de uma pasta local ou de um arquivo, aprovadas pelo hash das suas contribuições. Veja [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Configuração por repositório do que as sessões carregam, com predefinições nomeadas e controles que você pode mudar durante uma sessão. Veja [docs/KIT.md](../KIT.md).
- **Diagnósticos.** A verificação de saúde e o `/health` produzem um relatório respaldado por evidências de diagnóstico, com um veredito `certified`, `caution` ou `fault` e correções verificadas. Veja [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Confiança e permissões.** A confiança no workspace, as regras e os modos de permissão, e os comandos que todas as sessões recusam. Veja [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, a entrevista de especificação: responda às perguntas do agente para completar a especificação que ele usará para construir um protótipo. Veja [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Recuperação.** Publicação atômica, operações registradas em diário e reconciliação na inicialização. Veja [docs/DURABILITY.md](../DURABILITY.md).

As flags de execução são definidas em `src/substrate/flagRegistry.ts`, expostas como configurações `MERCURY_*` e geradas sob demanda. A compatibilidade com integrações está documentada em [docs/COMPATIBILITY.md](../COMPATIBILITY.md). O índice completo da documentação está em [docs/README.md](../README.md).

## Comandos slash

`/help` lista os comandos interativos disponíveis. Use `/palette` para a busca aproximada de comandos. A tabela abaixo agrupa os comandos integrados ativados por padrão segundo as categorias usadas em `/help`; a lista ao vivo também inclui `/samples` em `current work` quando Samples está ativado (`MERCURY_SAMPLES=1` ou a linha Samples do Boot Menu), `/showcase` quando `MERCURY_DEV_SURFACES=1` está definido, e quaisquer skills ou comandos de extensão.

| Categoria | Comandos |
| --- | --- |
| current work | `/run` `/runs` `/workbench` `/diff` `/mission` |
| crew & delegation | `/agents` `/crewmates` `/crew` `/workflows` `/daemon` `/saturn` `/seats` `/kill` `/unkill` |
| session & context | `/clear` `/compact` `/context` `/rewind` `/sessions` `/concourse` `/rename` `/title` `/contract` `/export` `/copy` `/usage` `/realms` `/restart` |
| memory & goals | `/memory` `/console` |
| model & effort | `/model` `/effort` `/submodels` `/advise` `/caching` |
| git & review | `/review` `/audit` |
| health & introspection | `/health` `/verify` `/trace` `/capabilities` `/lsp` |
| config & setup | `/config` `/jev` `/localsetup` `/llmhost` `/permissions` `/hooks` `/mcp` `/extensions` `/skills` `/browser` `/orient` `/keybindings` `/keys` `/vim` `/mouse` `/keysetup` `/bootmenu` `/voice` |
| appearance & cockpit | `/appearance` `/critter` `/palette` `/zen` `/browse` |
| account & app | `/logins` `/logout` `/accounts` `/defaultprovider` `/update-notes` `/feedback` `/help` `/exit` |

| Comando | O que faz |
| --- | --- |
| `/llmhost` | Escolha um modelo para alugar na Runpod, na Vast.ai ou na Lambda, executá-lo no seu próprio computador ou conectar um servidor existente. |
| `/restart` | Move este chat para a compilação do Mercury instalada; monitoramentos em execução e shells em segundo plano são interrompidos. |
| `/mcp` | Inspecione os servidores, faça login, navegue pelas ferramentas e parâmetros de cada servidor, reconecte ou ative e desative um servidor para este chat. |

`/mouse off` devolve o ponteiro ao terminal para a seleção e a cópia nativas de texto. A preferência fica salva e aparece em `/config` como Mouse capture.

Um argumento obrigatório começa com `<…>` no uso de um skill. Por exemplo, `/update-config` e `/debug` precisam de um argumento. Se você enviar um deles sozinho, recebe a descrição e o uso; nenhum turno é iniciado. Ao selecioná-lo no autocompletar e pressionar Enter, `/name ` fica pronto para você acrescentar o argumento. `/loop` não tem argumento obrigatório e roda imediatamente.

## Informar um problema

Para um relato curto, use [o formulário para testadores](https://mercury-cli.ai/report) ou `/bug --short <what you tried>` dentro do Mercury. Ele pede o seu sistema operacional, o que você tentou e o que quebrou; não é preciso enviar um despejo da verificação de saúde.

Execute `/bug <what happened>` dentro do Mercury para visualizar um relatório antes de enviá-lo pela GitHub CLI (`gh`) conectada. Sem o `gh`, o Mercury salva um rascunho local no diretório de configuração e indica a página de issues do repositório.

Você também pode abrir um issue diretamente, usando o modelo de bug, de provedor/modelo ou de solicitação de funcionalidade. Inclua a saída de `--version`, o sistema operacional, o terminal e os passos exatos. Relatórios de bug e de provedor também precisam de `mercury health --json`, ou de `node dist/mercury.mjs health --json` em uma compilação a partir do código-fonte. Uma transcrição da tela que falhou ajuda.

Reporte problemas de segurança em particular pela aba Security do repositório. Não os coloque em issues públicos. Veja [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) cobre issues, pull requests e verificações.

## Licença

O Mercury CLI é licenciado sob a Apache License 2.0 (`Apache-2.0`) em [LICENSE.md](../../LICENSE.md). Os SDKs de TypeScript e de Python em [sdk/](../../sdk/) e [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` no npm e no PyPI) também são licenciados sob a Apache License 2.0 (`Apache-2.0`), cada um pelo arquivo LICENSE que os acompanha ([sdk/LICENSE](../../sdk/LICENSE) e [sdk-py/LICENSE](../../sdk-py/LICENSE)).

O uso do nome e das marcas do Mercury é regido pela [política de marcas](../../TRADEMARKS.md). As licenças de terceiros incluídas estão listadas em [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
