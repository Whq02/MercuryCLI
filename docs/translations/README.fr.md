[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, paquet npm `mercury-tech-cli`) exécute des agents de programmation IA dans votre terminal, au sein de vos propres dépôts git, sur macOS, Linux et Windows.

Site web : [mercury-cli.ai](https://mercury-cli.ai) · Dépôt : [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm : `mercury-tech-cli`

Un agent lit et modifie des fichiers, exécute des commandes shell, parcourt pas à pas les tests et les débogueurs, puis vérifie les résultats. Vous choisissez le fournisseur de modèles, le modèle et ce que l'agent est autorisé à faire :

- **Concourse multi-session et worktrees isolés :** exécutez plusieurs sessions côte à côte dans le Session Concourse (`/concourse`), et déléguez le travail parallèle à des crewmates de différents fournisseurs (`Crewmate`) dans des copies de travail isolées (`git worktree`), avec des baux sur les fichiers du projet pour que les agents parallèles ne s'écrasent pas mutuellement.
- **20 fournisseurs de modèles, `/llmhost` et `/localsetup` :** gardez les 20 fournisseurs connectés en même temps (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI) et changez de fournisseur et de modèle en cours de conversation. Ouvrez `/llmhost` pour choisir un modèle, vérifier sa quantification, la répartition `conversations × context` et le niveau de réflexion, puis l'exécuter sur un GPU loué (Runpod, Vast.ai ou Lambda), sur votre propre ordinateur (`mercury host`) ou sur un serveur existant. Vous pouvez aussi lancer `/localsetup` pour installer Ollama ou le connecter, aux côtés de LM Studio, vLLM et llama.cpp.
- **Mémoire de projet RAG hybride Mneme :** utilise un modèle d'embeddings sémantiques BGE de 118 Mo, qui s'exécute sur l'appareil (`bge-base-en-v1.5`), avec un classement par mots BM25, un suivi des citations, des règles épinglées reproduites mot pour mot, un contexte de démarrage tenant compte de la branche, des contrôles de contradiction à l'écriture, des notes de passation entre sessions et le graphe `/memory page` dans le navigateur.
- **Outils de compilateur, AST et débogage DAP :** connecte l'intelligence de code LSP et des refactorisations prévisualisées (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), une recherche et une réécriture structurelles dans l'AST tree-sitter de 23 langages (`AstSearch`, `AstEdit`), un débogueur Debug Adapter Protocol intégré (`Debug`) (`debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`) pour entrer pas à pas dans les tests Python, Node, Go et Rust qui échouent, ainsi que des cellules `Eval` Python et JavaScript persistantes.
- **`WebSearch` sans clé et `WebFetch` en markdown :** effectue des recherches via la recherche native du fournisseur, les clés Brave ou Tavily, les API officielles (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG et DuckDuckGo sans clé, et récupère la documentation publique au format markdown dans une limite de 38 000 caractères par appel.
- **Utilisation de l'ordinateur, voix Whisper, planification Saturn et passerelles vers les éditeurs :** pilote les applications de bureau (`Computer`), transcrit en local la dictée vocale à l'appui (push-to-talk) avec Whisper (`/voice`), planifie des sessions récurrentes ou ponctuelles avec Saturn (`/saturn`), et se connecte à VS Code via l'Agent Client Protocol (`mercury acp`), ainsi qu'à Unity, Blender, Godot et Aseprite.
- **Génération de vidéos (`Video`) :** envoie des prompts et des fichiers de référence du projet à un générateur MiniMax configuré ([docs/VIDEO.md](../VIDEO.md)) et enregistre la vidéo MP4 générée et, en option, une image d'aperçu PNG à 1 seconde, dans votre projet.

Mercury sert à construire Mercury, en faisant tourner plusieurs sessions et plusieurs modèles sur de longues tâches. Le plus dur est de suivre ce travail : ce qui tourne encore, ce qui a changé et ce qui demande une décision. Chaque session rédige sa propre note de passation à la fin, et la session suivante lit cette note une seule fois au démarrage, avec mes règles épinglées ; la contamination du contexte d'une session à l'autre est ainsi évitée.

![Un seul prompt envoyé au coordinateur du tableau des sessions lance deux sessions, chacune dans son propre worktree ; l'une demande une confirmation avant de modifier, et les deux se terminent avec leurs modifications prêtes à être relues](../media/session-board-stream.gif)

Mercury est open source sous la licence Apache 2.0, tout comme les SDK situés dans [sdk/](../../sdk/) et [sdk-py/](../../sdk-py/).

## Installation

Les archives de version sont disponibles pour les Mac avec puce Apple et les Mac Intel, pour Linux x64 et arm64, et pour Windows x64 et arm64. Installez `git` séparément ; chaque archive inclut Node et ripgrep, si bien qu'une installation distincte de Node est inutile.

Choisissez une méthode d'installation :

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS et Linux (x64 et arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 et arm64), dans PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew : macOS et Linux x64
npm install -g mercury-tech-cli                    # npm ; `bun install -g mercury-tech-cli` désigne le même paquet
mise use -g npm:mercury-tech-cli                   # mise, via le paquet npm
```

Les adresses d'installation conservent des compteurs approximatifs des requêtes de script, par source et par jour UTC (les installations terminées ne sont pas comptées) ; le compteur ne stocke ni adresse IP, ni chaîne user-agent, ni cookie.

Ouvrez un nouveau terminal, ou exécutez la ligne `export PATH=…` qu'affiche l'installateur shell, puis lancez `mercury --version` pour la vérifier, et `mercury` depuis un dépôt pour démarrer le [premier lancement](#premier-lancement). Sous Windows PowerShell, ainsi qu'après une installation avec Homebrew, npm, bun ou mise, `mercury` fonctionne dans le même terminal.

<details>
<summary>Emplacements d'installation, mises à jour et vérification des versions publiées</summary>

### Différences entre les méthodes d'installation

Les installateurs shell et PowerShell récupèrent la version la plus récente pour votre plateforme, vérifient son SHA-256 par rapport à `SHA256SUMS.txt`, la décompressent et exécutent la commande `mercury install` propre à l'archive.

Homebrew et le paquet npm sont chacun figés sur une version précise et republiés après la création d'un tag ; ils peuvent donc accuser un retard sur la version la plus récente. Les commandes Homebrew utilisent le nom complet du tap `Whq02/mercury/mercury` (le `mercury` nu de `homebrew-core` désigne un autre programme). Le paquet npm `mercury-tech-cli` est un lanceur qui télécharge la version figée qu'il épingle ; mise installe ce même paquet. `mercury install --uninstall` supprime la version installée et le shim de commande, tout en conservant votre configuration et vos sessions (exécutez aussi `npm uninstall -g mercury-tech-cli` si vous avez installé le lanceur npm).

L'installation de Mercury est locale à l'utilisateur et ne nécessite pas de droits d'administrateur. Vous pouvez relancer une commande d'installation sans risque.

### Emplacements d'installation

Les versions publiées se trouvent sous le répertoire de configuration, dans `~/.mercury/versions/<version>` (`%USERPROFILE%\.mercury\versions` sous Windows). La commande `mercury` est installée dans `~/.local/bin` sous macOS et Linux, ou dans `%LOCALAPPDATA%\Mercury\bin` sous Windows.

`mercury install` ajoute le répertoire de la commande au PATH une seule fois : une ligne balisée dans le fichier de démarrage de votre shell, ou une entrée dans le PATH utilisateur de Windows. Un nouveau terminal prend cette modification automatiquement en compte.

### Mises à jour

Utilisez `mercury update` quelle que soit la méthode d'installation.

Pour une installation réalisée avec l'installateur shell ou PowerShell, ou avec `mercury install`, la commande met Mercury à jour sur place. `--check` vérifie les mises à jour, `--status` affiche leur état, et `--rollback` revient à la version précédente, qui reste sur le disque.

Avec Homebrew, la commande demande confirmation avant d'exécuter `brew upgrade Whq02/mercury/mercury`. La réponse par défaut est non ; saisissez `y` pour approuver. Mercury affiche en continu la sortie de la commande et vérifie ensuite la version installée. Utilisez `--yes` pour ignorer la question dans les scripts.

Le lanceur npm utilise la même organisation de versions que les installateurs et délègue chaque exécution à la version installée. `mercury update` met donc à jour une installation npm sur place, par le canal de mise à jour propre à Mercury. `npm update -g mercury-tech-cli` ne change que la version que le paquet installe lors de sa première exécution. Cela vaut aussi lorsque vous utilisez mise.

`--check` lit la même liste de versions pour toutes les méthodes d'installation et indique comment mettre à jour la vôtre. Lorsqu'une mise à jour est disponible, l'écran d'accueil affiche une fois `vX.Y.Z available · mercury update` dans son coin inférieur droit, et la conversation affiche la même notification jusqu'à ce que vous mettiez à jour. Définissez `MERCURY_UPDATE_NOTICE=0` pour masquer les deux.

Les demandes d'installation et de mise à jour récupèrent anonymement la liste publique des versions et les archives. Vous pouvez les lancer sans compte ni token. Si une demande anonyme est refusée, Mercury consulte la GitHub CLI (`gh`) connectée.

Après une mise à jour, Mercury vérifie si la commande présente dans votre PATH pointe vers l'installation mise à jour. Si une autre installation a la priorité, ou si la commande mise à jour est absente du PATH, il explique le problème et la solution. `mercury health` signale le même problème.

### Vérification des versions publiées

Avant d'activer une version, Mercury vérifie son archive par rapport à `SHA256SUMS.txt`. Il exige aussi une charge utile signée par la clé de signature des versions de Mercury, présente dans la liste de confiance intégrée au binaire, avant de préparer la mise à jour. Une signature rejetée laisse l'installation active inchangée.

Utilisez `--allow-unsigned` pour accepter une charge utile non signée. Mercury rejette toujours les clés de signature inconnues, les blocs de signature malformés et les contenus altérés. Le résultat de la commande et son enregistrement local indiquent tous deux que vous avez accepté une charge utile non signée.

Les archives de version sont signées. Exécutez `mercury health` pour examiner la signature de la version installée.

Une archive sans signature de version est marquée comme non signée. L'installation et la mise à jour la refusent, sauf si vous passez `--allow-unsigned`.

[docs/TRUST.md](../TRUST.md) explique les résultats de vérification et la manière de contrôler une archive à la main. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) traite de la vérification au démarrage.

### Notes sur les plateformes

Des archives de version existent pour chaque plateforme listée ci-dessus. Toute autre machine se compile à partir des sources.

Des archives de version pour Mac Intel sont disponibles.

</details>

## Prérequis

Les archives de version incluent Node 24 LTS. Le lanceur, `mercury install` et `mercury update` utilisent ce runtime intégré ; `git` est la seule dépendance séparée requise par la version elle-même.

Pour compiler depuis les sources, il vous faut :

- **Node 24 LTS**, dans la plage prise en charge `>=24.20.0 <25`. `.node-version` fixe la version corrective utilisée pour la compilation et incluse dans les archives de version.
- **bun 1.3.x** pour la compilation. Il n'est pas inclus dans les versions publiées.
- **git**. Sous Windows, lancez PowerShell 7 dans Windows Terminal ou dans le terminal de VS Code. Voir [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

Le minimum de Node intègre le correctif de nodejs/node#56645. En dessous de 24.20.0, les commandes `run` sans interface qui appellent un outil s'interrompent à la sortie sous Windows.

Les lanceurs choisissent Node dans cet ordre : le binaire explicite `MERCURY_NODE`, le runtime intégré, puis une installation compatible de Node présente dans le PATH. Si le runtime est absent, le lanceur signale une erreur.

### Shells Windows

Les archives de version incluent le moteur shell compatible bash de Mercury (`brush`). Sous Windows, il sert par défaut l'outil Bash : il trouve un programme `.cmd` ou `.bat`, comme `npm`, par son seul nom grâce à PATHEXT, transmet `%VAR%` et `^` à un fichier batch sans les modifier, exécute après `cd` un programme désigné par un chemin relatif, et conserve l'état du shell entre les appels. Le `bash.exe` de Git for Windows n'est pas requis ; lorsqu'il est installé, `MERCURY_SHELL_ENGINE=system`, ou `system` dans `/config` sous Shell engine, fait tourner l'outil Bash sur `bash.exe` seul.

Lisez la ligne `shell` du contrôle de santé pour voir quel shell est actif et pourquoi : le moteur intégré (la valeur par défaut sous Windows, ou activé par l'épinglage ou par le réglage), ou Git Bash lorsque le moteur a été désactivé ou que son pack est absent.

Sous macOS et Linux, le shell système est la valeur par défaut ; définissez `MERCURY_SHELL_ENGINE=brush`, ou choisissez `brush` dans `/config`, sous Shell engine, pour faire tourner aussi l'outil Bash sur le moteur intégré, avec un état du shell persistant.

Une compilation depuis les sources sans le pack du moteur ni Git pour Windows démarre quand même, mais l'outil Bash n'est pas disponible. L'outil PowerShell reste disponible, et le diagnostic `shell` explique comment rétablir la prise en charge de Bash.

## Compiler depuis les sources

Mercury se compile avec bun et s'exécute sur Node 24 LTS. Installez [les prérequis de compilation](#prérequis), y compris bun 1.3.x :

```sh
curl -fsSL https://bun.sh/install | bash           # macOS et Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, dans PowerShell 7
bun --version                                      # 1.3.x
```

Puis, dans un clone de ce dépôt :

```sh
bun run setup                      # une seule fois ; bun install + les packs vendorisés
bun run build.ts                   # écrit dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Prise en charge du terminal

L'interface plein écran nécessite un vrai TTY, mais n'impose aucune taille minimale de terminal. La disposition complète commence à 100 colonnes sur 26 lignes ; les fenêtres plus petites utilisent une disposition compacte.

Mercury utilise les couleurs 24 bits lorsque le terminal annonce leur prise en charge via `COLORTERM=truecolor`, ou lorsqu'il est reconnu comme iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal ou VS Code. Les autres terminaux utilisent 256 couleurs, y compris Terminal d'Apple sous macOS 15 et les versions antérieures.

La ligne Terminal color du contrôle de santé indique la profondeur détectée et la raison. Définissez `MERCURY_TRUECOLOR=1` pour un terminal qui prend en charge les couleurs vraies sans l'annoncer, ou `MERCURY_TRUECOLOR=0` pour forcer 256 couleurs.

### Composants facultatifs

`setup` récupère les packs de capacités intégrés : pyright, debugpy, js-debug, les grammaires supplémentaires, le runtime Node de la plateforme et brush. Si un téléchargement échoue, ce pack est ignoré, et la compilation ainsi que les outils concernés signalent le composant manquant. Exécuter `bun install` seul produit une compilation sans ces packs.

Pour compiler la prise en charge de la voix, lancez `setup` avec Rust installé. Cela compile `native/voice`. Ajoutez cmake pour compiler aussi `native/whisper`. Avec Rust installé, `setup` compile aussi l'addon du pilote de bureau (`native/desktop`) qu'utilise l'outil `Computer`. Toujours avec Rust installé, `setup` compile en outre l'addon d'embeddings local (`native/embed`, `bun run scripts/vendor/build-embed.ts`) et récupère le modèle BGE de 118 Mo (`bun run scripts/vendor/fetch-embed-models.ts --default`). Sans cargo, le pack est ignoré, setup le signale, et la recherche dans la mémoire Mneme ne fait qu'une correspondance de mots. Chaque archive de version embarque le pack d'embeddings compilé pour sa plateforme ; sous Linux et Windows, les calculs utilisent un noyau vectorisé, si bien qu'un Recall par le sens prend environ un dixième de seconde (quelques centièmes sous macOS, qui utilise Accelerate). Si une compilation native n'a pas ses outils, setup la saute et le contrôle de santé signale l'addon manquant. Le moteur shell Windows est lui aussi compilé sur votre machine, car le projet amont ne fournit pas de binaire Windows.

Voir [Shells Windows](#shells-windows) et [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) pour le moteur shell `brush`.

La compilation n'écrit que dans `dist/`. La configuration et les sessions se trouvent dans `~/.mercury`, ou dans le répertoire défini par `MERCURY_CONFIG_DIR`, et sont créées au premier lancement. Sous Windows, exécutez directement `node dist\mercury.mjs`.

### Installer une compilation depuis les sources comme commande

`scripts/ops/deploy-runtime.sh` publie une compilation à partir d'un arbre propre dans un nouveau dossier `<config home>/runtime/builds/<build>` et fait pointer `runtime/current` vers celui-ci (`runtime/dist` est l'ancien nom du même lien). `scripts/ops/deploy-launcher.sh` installe le lanceur dans `<config home>/bin/mercury`. Ajoutez ce répertoire au PATH ; pour zsh :

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

Le lanceur s'arrête avec une erreur si le runtime est absent. Il ne bascule pas vers une autre compilation. Le choix de Node suit l'ordre décrit dans [Prérequis](#prérequis). Pour une installation de version, exécutez `mercury install` ou `mercury update`, qui laissent inchangées les copies de travail des sources ; voir [Mises à jour](#mises-à-jour).

[AGENTS.md](../../AGENTS.md) est le guide court de compilation et d'exécution. [BUILD-NOTES.md](../../BUILD-NOTES.md) détaille davantage la compilation.

## Premier lancement

Au premier lancement interactif, choisissez une apparence, puis connectez-vous à un fournisseur. L'écran prévisualise les changements de thème pendant que vous parcourez les options. True Black est le réglage par défaut ; les autres options sont le thème sombre oasis et Black and white, qui n'applique aucune couleur : l'encre propre au terminal sur son propre fond, tel que Mercury s'affiche sur un terminal sans couleur. Vous pouvez modifier ce réglage plus tard avec `/appearance`.

Vous pouvez aussi choisir « sign in later » pour regarder sans connecter de compte. Lorsqu'une clé de fournisseur présente dans votre environnement connecte déjà un fournisseur, l'étape de connexion n'est pas proposée. Ensuite, l'étape Guardrails vous rappelle de vérifier les modifications et les commandes de Mercury, et que les contenus lus peuvent contenir des instructions destinées au modèle. Dans un terminal que Mercury sait configurer (Terminal.app, la famille VS Code, Alacritty, Zed), une étape Terminal keys peut configurer les raccourcis de saut de ligne dans les réglages propres au terminal (sous macOS, dans Terminal.app, elle définit `Option+Enter` pour un saut de ligne et coupe la cloche du terminal pour tous les profils, ce qui prend effet après le redémarrage de Terminal.app ; dans la famille VS Code, Alacritty et Zed, elle écrit `Shift+Enter` pour un saut de ligne). Elle est désactivée tant que vous ne la choisissez pas, et une sauvegarde est conservée.

Ensuite, Mercury vous demande si vous faites confiance au dossier ouvert. Rien de ce qu'une configuration d'espace de travail demande ne s'exécute avant que vous n'ayez accordé cette confiance. L'autorisation couvre tout le dépôt ; la refuser quitte Mercury. Voir [docs/TRUST.md](../TRUST.md).

Un lancement interactif normal ouvre l'écran d'accueil. Il comporte dix entrées de menu, et Continue Last Session n'apparaît qu'une fois que vous avez un historique de sessions :

- **New Session in \<folder\>** démarre une nouvelle session dans le dossier courant.
- **Continue Last Session** revient à votre conversation la plus récente.
- **Boot Menu** configure les sessions futures, y compris motion, crewmates et workflows.
- **MCPs & Skills** choisit ce que charge la prochaine session. Voir [docs/KIT.md](../KIT.md).
- **Agents** crée et modifie les agents.
- **Health Check** vérifie l'installation.
- **Saturn Scheduler** planifie des sessions. Voir [docs/SATURN.md](../SATURN.md).
- **Logins** connecte les comptes des fournisseurs.
- **Session Concourse** ouvre la liste des sessions du projet actuel.
- **Sessions · Projects** vous permet de choisir une session ou un dépôt.

Les entrées de menu s'ouvrent par-dessus l'écran d'accueil, et `Esc` vous ramène à l'entrée sélectionnée. La liste des sessions s'ouvre sur un écran séparé, également accessible avec `Shift+→`. Un argument de prompt, `--continue` ou `--resume` vous mène directement à la conversation.

### Motion, crewmates et workflows

La section Performance du Boot Menu comprend un réglage Motion : `auto`, `full`, `reduced` ou `off`. Il contrôle l'animation au repos de l'interface et est aussi disponible dans `/config`.

Sous Agents, les commutateurs Crewmates et Workflows déterminent si les nouvelles sessions reçoivent les outils Crewmate et Workflow. Désactiver un commutateur retire l'outil correspondant ; les tentatives de lancer ce type de travail renvoient la même explication. Dans une session, `/crewmates on|off` et `/workflows on|off` modifient le réglage à partir du tour suivant.

## La boucle quotidienne : Session Concourse, worktrees git et crewmates

### Démarrer une session et isoler les worktrees

Appuyez sur `Enter` sur New Session pour créer une session dans le dossier courant avec votre modèle par défaut. Mercury ouvre sa conversation et l'ajoute en même temps à la liste des sessions. Il garde un processus prêt derrière le menu pour réduire le travail de démarrage.

Démarrer une autre session n'arrête pas la précédente. Vous pouvez laisser une tâche tourner et travailler ailleurs. Lancez avec `--worktree [name]` (ou demandez un `worktree` dans la conversation pour exécuter `EnterWorktree`) afin de donner à une session sa propre branche et sa propre copie de travail sous `.mercury/worktrees/`. Les crewmates parallèles peuvent aussi s'exécuter dans des worktrees isolés et coordonner les fichiers partagés grâce aux baux de fichiers du projet ; voir [Ce qui est inclus](#ce-qui-est-inclus-mémoire-rag-mneme-lsp-ast-pour-23-langages-débogueur-dap-recherche-web-et-passerelles) et [docs/CREW.md](../CREW.md).

### Travailler dans la conversation

Décrivez le travail en langage courant. L'agent lit, modifie, exécute et vérifie le code selon le mode d'autorisation que vous avez choisi. Les appels d'outils s'affichent au fur et à mesure de leur exécution, soit sous forme de cartes compactes, soit avec la sortie complète. Choisissez l'affichage dans `/config`, sous Tool output ; le réglage est enregistré pour les prochains lancements.

Utilisez `/model` et `/effort` pour ajuster la session. `/permissions` définit ce qui peut s'exécuter sans approbation et ce qui doit demander une confirmation au préalable.

Examinez les modifications avec `/diff`, par source, fichier et hunk. `! <command>` exécute une commande shell dans la conversation, avec un suivi de sortie en direct. `/runs` affiche les shells et les crewmates en cours d'exécution (`/tasks` ouvre le même tableau), et `/crewmates` ouvre la vue Crew en direct. Entre deux tours, `/clear` enregistre la conversation en cours et ouvre une session neuve, et `/restart` fait passer la conversation sur une version de Mercury nouvellement installée. `/title` nomme la conversation, et `/help` liste les commandes disponibles.

### Passer d'un écran à l'autre

`Shift+←` et `Shift+→` permettent de passer d'un écran à l'autre parmi ceux qui sont disponibles. Un lancement neuf affiche l'écran d'accueil et la liste des sessions. L'écran de conversation est ajouté lorsqu'une session est sélectionnée et retiré lorsque la dernière conversation se ferme. Les indications de touches n'affichent que les déplacements possibles.

Fermer toutes les conversations vous ramène à l'écran d'accueil. Utilisez `--chat` pour n'avoir que l'écran d'accueil et la conversation, sans la liste des sessions. `--concourse-off` enregistre ce choix pour les prochains lancements ; `--concourse-on` ou `/config` le réactive.

### Gérer les sessions dans le Session Concourse

Ouvrez la liste des sessions avec `/concourse` ou `Shift+→` depuis l'écran d'accueil. Elle affiche d'abord les sessions en cours d'exécution du projet actuel, suivies des conversations enregistrées qui ne tournent pas, de la plus récente à la plus ancienne.

Chaque session en cours d'exécution possède une cellule NOW qui affiche son activité actuelle. Sélectionnez une ligne et appuyez sur `Enter` pour revenir à la conversation, pendant que les autres sessions continuent de tourner. Une session plantée reste dans la liste avec la mention NEEDS YOU et la raison, jusqu'à ce que vous la libériez.

[docs/SESSIONS.md](../SESSIONS.md) décrit le cycle de vie des sessions.

## Fournisseurs et modèles : connexions, `/localsetup` et `/llmhost`

Utilisez `/logins` pour connecter un fournisseur. Cela ouvre le même catalogue de connexion que pendant la configuration. `/accounts` gère ensuite les emplacements de fournisseurs connectés.

- **OpenAI :** abonnement ChatGPT ou clé API.
- **Anthropic :** abonnement Claude, connexion à la Console ou clé API.
- **OpenRouter :** accès au catalogue par OAuth ou par clé API ; les requêtes de modèle refusent la collecte de données et exigent tous les paramètres dès le départ. `/config → OpenRouter routing policy` définit les choix de repli et de non-conservation des données ; choisissez open pour assouplir la politique et laisser le routage à OpenRouter.
- **Google Gemini :** Sign in with Google, une clé API ou votre propre client OAuth. Sign in with Google fait fonctionner Gemini sur le quota du forfait détenu par le compte Google (compte gratuit, Google AI Pro ou Google AI Ultra), via le client Antigravity de Google : le prompt, les schémas d'outils et les résultats des outils sont envoyés au point de terminaison Code Assist de Google, sous ce client et avec le compte connecté, et `/model` liste les modèles que Google met à disposition du compte. Une clé API ou votre propre client OAuth facture à la place un projet Cloud.
- **Hugging Face :** connexion par code d'appareil ou token Hub.
- **Kimi (Moonshot) :** connexion par code d'appareil ou clé API.
- **GLM (Z.AI) :** une clé d'abonnement GLM Coding Plan ou une clé d'API générale au paiement à l'usage. `/logins zai` enregistre l'une ou l'autre et note le forfait ; `ZAI_API_KEY` fonctionne aussi, avec `ZAI_KEY_PLAN=coding|general` qui désigne le forfait (si elle n'est pas définie, Mercury le lit dans la liste des modèles propre à la clé).
- **DeepSeek :** une clé API de la plateforme DeepSeek (`/logins deepseek`, ou `DEEPSEEK_API_KEY`).
- **xAI (Grok) :** connectez-vous avec votre abonnement Grok (SuperGrok / X Premium) ou collez une clé API via `/logins xai`.
- **Meta (Muse) :** Sign in with Meta (un abonnement Muse Code, un code d'appareil dans votre navigateur) ou une clé Model API au paiement à l'usage. Sign in with Meta échange le code d'appareil contre les points de terminaison OIDC de Meta (`https://auth.meta.com/oidc/device/authorization/` et `/oidc/device/token/`) sous l'identifiant client public de Muse Code, envoie une seule fois le jeton de compte obtenu à `https://api.meta.ai/muse-code/key` pour générer la clé API de l'abonnement (ainsi que des lectures bornées de `/usage` pour le palier du forfait et ses fenêtres d'utilisation), et n'envoie que la clé générée à chaque requête de modèle vers `https://api.meta.ai/v1`. Une clé Model API collée, ou `MODEL_API_KEY` / `META_API_KEY`, est facturée à l'usage.

- **Qwen :** une clé QwenCloud (Token Plan ou paiement à l'usage) ou une clé Alibaba Cloud Model Studio (paiement à l'usage, Token Plan ou Coding Plan), vérifiée sur son propre point de terminaison avant d'être enregistrée ; une clé de forfait liste les modèles du forfait, Qwen3.8 Max en premier.
- **MiniMax :** une clé Open Platform ou une clé d'abonnement M Plan.
- **Together AI** et **Cohere :** clé API.
- **Groq**, **Cerebras** et **Fireworks AI :** clé API ; la clé de chaque famille peut aussi provenir d'une commande désignée dans `credentials.keyCommands.<family>`.

Mistral, Nous Portal et OpenCode Zen se connectent aussi par `/logins`, soit 20 familles de fournisseurs au total. Les serveurs de modèles locaux (Ollama, LM Studio, vLLM et llama.cpp) et les points de terminaison personnalisés compatibles OpenAI fonctionnent sans connexion à un fournisseur. Exécutez `/localsetup` pour installer ou démarrer Ollama, télécharger un modèle qui tient dans votre mémoire, définir sa fenêtre de contexte, ou connecter un serveur LM Studio, vLLM ou llama.cpp déjà lancé ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Chaque fournisseur utilise son propre protocole, ses propres identifiants et sa propre gestion des erreurs, et les requêtes ne basculent jamais vers un autre fournisseur. Voir [docs/ENGINES.md](../ENGINES.md).

`/llmhost` liste les modèles que vous pouvez héberger et indique où chacun peut tourner à l'instant : sur un GPU loué chez Runpod, Vast.ai ou Lambda, sur votre propre ordinateur ou sur un ordinateur SSH enregistré (`mercury host`), ou sur un serveur de modèles existant. Chaque page de modèle présente les options de quantification, la façon dont le budget de mémoire GPU se répartit entre les conversations parallèles (`conversations × context`), et le niveau de réflexion par défaut (que `/effort` modifie à chaque requête). Les locations de GPU exigent une confirmation explicite du prix horaire, et l'installation se poursuit en arrière-plan si vous fermez la fenêtre pop-up. Sur Runpod, vous pouvez aussi régler la qualité, la répartition du contexte et la réflexion avant de louer ou sur un pod en cours d'exécution (`Tune`), conserver les poids sur un volume à chargement rapide, et définir des surveillances de stock toutes les 5 secondes. Les locations Vast.ai et Lambda sont nouvelles dans la 1.0.0-beta.40 et ont été vérifiées face aux API publiées des fournisseurs, sur des fixtures (aucune location en conditions réelles n'a été effectuée). Voir [docs/LLM-HOST.md](../LLM-HOST.md).

Les nouvelles sessions utilisent le fournisseur que vous avez connecté en dernier et le modèle le plus récent disponible pour ce compte. Les modèles auxquels le compte n'a pas accès sont ignorés. Si ce fournisseur n'a aucun modèle utilisable, Mercury vérifie alors le fournisseur connecté ensuite le plus récemment. Ce choix a lieu au démarrage de la session ; une requête échouée dans une session existante reste chez son fournisseur.

`/model` explique la sélection. Un nom de famille choisit le modèle le plus récent de cette famille : `/model grok`, `/model deepseek`, `/model kimi` ou `/model glm`. Sans fournisseur connecté, l'écran d'accueil et `/model` vous renvoient vers `/logins`. `/defaultprovider` vous permet de faire explicitement d'un fournisseur le choix le plus récent.

L'accès aux fournisseurs reste soumis aux conditions et à la disponibilité propres à chacun. La licence de Mercury ne les remplace pas.

## La CLI sans interface : `mercury run`, Docker et l'exécuteur JSON-RPC

La même compilation s'exécute sans l'interface interactive. `node dist/mercury.mjs --help` liste toutes les options.

`mercury run "<prompt>"` exécute un prompt sans interface de terminal :

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` affiche la réponse ; la raison d'un tour en échec est envoyée sur stderr.
- `json` affiche la dernière ligne `outcome` sous forme d'un objet JSON unique.
- `rows` écrit un objet JSON par ligne : `session`, puis un `turn` et ses lignes `text`, `reasoning`, `tool_call`, `tool_result` et `step`, qui se termine par `outcome`. Les attentes, la progression des outils, les tâches d'arrière-plan et les notifications ont leurs propres lignes. Chaque ligne porte `seq`, `timestamp` et `session_id` ; les lignes d'un tour portent aussi son numéro `turn`. `seq` numérote le flux de cette exécution à partir de 1 ; `turn` compte les tours de la session, si bien qu'une exécution qui poursuit une conversation enregistrée (`-c`, `-r`, `--fork`) numérote son tour à la suite des tours déjà présents, et sa ligne `session` indique la conversation poursuivie dans `resume_of`.

Les types de lignes de sortie, selon leur champ `type` :

- `session` : la ligne d'ouverture : `version`, `build` (les douze premiers caractères hexadécimaux de l'arborescence dont le bundle est issu, tels que les affiche `mercury daemon status` ; absent lorsqu'aucun manifeste ne se trouve à côté du bundle), `resume_of` (pour une exécution poursuivie, l'identifiant de session de la conversation poursuivie ; le même identifiant que `session_id`, sauf si l'exécution a été bifurquée), `cwd`, `model`, `mode`, les `tools`, `mcp_servers`, `commands`, `agents`, `skills` et `extensions` de la session, ainsi que `tools_withheld` (présent lorsqu'une règle de refus retire un outil par son nom nu : chaque entrée donne `tool`, `rule` et `source`).
- `turn` : un tour au statut `started` ou `waiting`, avec son `turn_id` ; `model`, `message_ids` et le nombre `agents` lorsqu'ils sont connus.
- `text` : un bloc de texte finalisé : `message_id`, `block`, `text`, et sa `phase` (`commentary` ou `final_answer`).
- `reasoning` : un bloc de raisonnement finalisé : `message_id`, `block`, `text`, ou `redacted: true`.
- `tool_call` : un appel d'outil : `call_id`, `tool`, `input`, avec son `message_id` et son `block`.
- `tool_result` : le résultat de l'appel : `call_id`, `status` (`ok`, `error`, `aborted` ou `refused`) et `output`. Un appel si mal formé par le modèle qu'il a été refusé avant exécution (outil inconnu, arguments qui ne sont pas du JSON valide ou ne correspondent pas au schéma de l'outil) reçoit tout de même sa paire : une ligne `tool_call` avec les arguments tels qu'ils ont été transmis (`{}` lorsqu'ils n'étaient pas un objet), et une ligne `tool_result` au statut `refused` dont `output` donne la raison ; la `notice` de correction suit. Un tel appel n'a jamais été exécuté et n'est pas un refus.
- `tool_update` : progression d'un outil en cours d'exécution : `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` ou `eval`), et ceux parmi `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` et `total` que l'appel renseigne. Un appel shell ou PowerShell émet un tick à mesure que sa sortie arrive (une commande qui n'affiche rien n'émet jamais de tick), un appel MCP lorsque son serveur signale sa progression, un appel Eval pendant l'exécution de sa cellule ; aucun autre outil n'émet de tick ; un appel Browser ou Crewmate reste silencieux jusqu'à son résultat.
- `step` : un appel de modèle du fil principal : `message_id`, `model`, `usage`, et `stop` lorsque le modèle a indiqué la raison de son arrêt.
- `outcome` : le résultat du tour, décrit ci-dessous.
- `close` : la note laissée à la session suivante à la fermeture : `state` (`stored`, `skipped` ou `none`), `note_chars`, et le `usage` des appels de modèle qui l'ont rédigée, afin qu'un lecteur qui additionne l'usage de toutes les lignes retrouve celui du résultat. Lorsque le prompt est donné en argument, la note est demandée à l'intérieur du dernier tour et `close` précède le `outcome` de ce tour ; avec `--input rows`, elle suit le dernier `outcome` une fois stdin fermé.
- `wait` : une attente du modèle : `state` (`first_byte`, `retry`, `silence`, `loading` ou `done`), accompagné des valeurs propres à cet état, comme `since_ms`, `attempt` et `of`, `delay_ms`, `reason` et `http_status`.
- `heartbeat` : le flux du modèle a donné signe de vie après au moins une seconde sans événement analysé : des octets sont arrivés sans produire de ligne. La ligne ne porte rien d'autre et n'arrive au plus qu'une fois par seconde ; sa fréquence dépend du mode de streaming du fournisseur, si bien qu'un flux qui ne marque jamais de pause entre deux événements n'en émet aucune.
- `compaction` : une compaction `started`, `progress` ou `ended` : `trigger` (`manual`, `auto` ou `overflow`), `stage`, `fill`, `summary_tokens` et, à la fin, `exit` (`landed`, `cancelled` ou `failed`).
- `mode` : le mode d'autorisation a changé : `mode`.
- `rate_limit` : l'état de la limite du fournisseur : `status` (`allowed`, `warning` ou `rejected`), `window`, `resets_at`, `utilization` et les champs de dépassement.
- `task` : une tâche d'arrière-plan `started`, `progress` ou `ended` : `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` ou `stopped`) et `output_file`, au fur et à mesure qu'ils sont connus.
- `notice` : un message `warning` ou `error` destiné au lecteur : `text`, et un `code` tel que `input_refused`.
- `command_output` : la sortie d'une commande slash qui n'a jamais atteint le modèle : `command` et `text`.
- `mission_updated` : le registre des tâches de la session a changé ; relisez-le.
- `samples_updated` : les échantillons de la session ont changé ; relisez-les.

`--partial` avec `--format rows` ajoute les lignes `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` et `retracted`. Les deltas appartiennent à `message_id` et `block` ; une ligne `retracted` retire les deltas de ce message. La ligne de texte ou d'outil finalisée donne la valeur complète.

Le résultat contient `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` et `denials`, avec `answer` à l'achèvement et `error` (`message`, `class`, `detail` facultatif) en cas d'échec. `stop`, `api_ms`, `cost_usd`, la sortie `structured` demandée et `notices` sont inclus lorsqu'ils sont disponibles. `wall_ms` est la durée écoulée du tour. `api_ms` est la somme des durées de chaque requête de modèle émise pendant le tour (y compris les nouvelles tentatives et les requêtes des crewmates exécutées en parallèle du fil principal), de sorte qu'il peut dépasser `wall_ms` lorsque des requêtes se chevauchent. `cost_usd` est le montant en USD des requêtes du tour dont le prix est connu, quel que soit le statut : une requête que Mercury ne peut pas chiffrer (aucun tarif enregistré, aucun coût indiqué dans la réponse) n'y ajoute rien et laisse son modèle listé dans `models` sans `cost_usd` propre ; le champ est absent seulement lorsque rien du tour n'a été tarifé. Avec une connexion par abonnement Claude, les requêtes Anthropic n'ont pas de prix en dollars ; elles et la ligne ne portent donc pas de `cost_usd`, mais l'usage reste. L'usage indique `input_tokens` (tokens en cache inclus), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` et, lorsqu'ils sont renseignés, `reasoning_output_tokens`, additionnés pour le fil principal et les crewmates. `models` ventile l'usage des tokens par modèle. `steps` ne compte que les appels de modèle de l'agent principal ; les appels de modèle des crewmates apparaissent comme leurs propres lignes `step`, étiquetées avec `parent_call_id`.

Le statut est `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` ou `loop_stopped`. Une exécution sous `--max-time` (en secondes, ou `10m`, `1h`) se termine en `time_limit` à l'étape suivante une fois le délai écoulé ; l'appel de modèle ou le tour d'outils en cours n'est pas interrompu. Une exécution terminée sort avec le code 0, les autres résultats sortent avec le code 1, et une erreur d'utilisation sort avec le code 2. SIGINT et SIGTERM sortent avec les codes 130 et 143 une fois le résultat du tour interrompu écrit. Un appel d'outil refusé est listé dans `denials`. Lorsque le refus provient d'une demande d'autorisation à laquelle personne n'a pu répondre (une exécution sans hôte dans un mode qui demande, `--mode dontAsk`, ou une demande de l'hôte arrivée à expiration) et qu'aucun appel d'outil ultérieur du tour ne réussit, l'exécution est `blocked` : la réponse est conservée, `error` désigne l'outil et la manière de reprendre (`--allowed-tools`, un autre `--mode`, ou un hôte qui répond aux demandes), et l'exécution sort avec le code 1. Si un appel d'outil ultérieur du même tour réussit, le tour se rétablit et se termine en `completed` (code 0) avec une `notice` d'avertissement (`"<Tool> was not approved; the run continued with other tools."`). Un refus auquel vous avez répondu (par une règle de refus, un hook ou un hôte qui a dit non) laisse terminé un tour terminé. Un appel `AskUserQuestion` resté sans réponse termine aussi l'exécution en `blocked`, avec la question citée dans `error` ; Mercury lit le résultat dans les demandes enregistrées de l'exécution, jamais dans le texte de la réponse, de sorte qu'une question écrite seulement dans la réponse aboutit à `completed`. Une commande slash inconnue reçoit le statut `refused` avec la même phrase que l'écran interactif (`Unknown command: /name · /help lists commands`) et sort avec le code 1.

`--input rows` exige `--format rows` et lit un objet d'entrée par ligne :

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Les types d'entrée sont `prompt` avec `content` (blocs texte ou texte/image), `shell` avec `command`, et `note` avec `to` (un identifiant d'agent) et `content`. Chacun accepte un `id` facultatif ; les lignes prompt et shell acceptent aussi `priority` (`now`, `next` ou `later`), `sent_at` et `origin`. Une forme d'entrée rejetée produit une `notice` au code `input_refused` ; un JSON mal formé met fin à l'exécution. Ces lignes ne transportent que des entrées ; les réponses aux demandes d'autorisation passent par le protocole d'exécuteur décrit plus bas.

Utilisez `mercury run -`, ou envoyez du texte dans `mercury run` par un tube, pour lire le prompt complet depuis stdin. À côté d'un argument de prompt, le texte transmis par tube est ajouté comme contexte délimité : le tube est lu jusqu'à sa fermeture ou jusqu'à un silence d'une seconde, de sorte qu'un flux qui continue d'alimenter est lu jusqu'au bout, et qu'un tube resté ouvert et silencieux ne bloque pas l'exécution. Sans prompt et avec un terminal sur stdin, `run` affiche son usage et sort avec le code 2.

`--mode <mode>` sélectionne la posture d'autorisation. `--sovereign` s'exécute sans demandes d'autorisation, et `--allow-sovereign` rend cette posture disponible pour un changement ultérieur. La politique d'autorisation et les règles de refus s'appliquent toujours. Un utilisateur root qui passe en mode sovereign reçoit une notice sur stderr ; l'exécution se poursuit.

Utilisez `-c` pour poursuivre la conversation la plus récente, `-r` pour reprendre par identifiant, titre ou sélecteur, `-w` pour exécuter dans un worktree géré, et `--lean` pour une session minimale. Une exécution `run` n'a pas d'hôte pour répondre aux demandes d'autorisation : ses règles d'autorisation et son mode décident de ce qui peut s'exécuter, et un appel qui nécessite encore une approbation est refusé.

### L'image sans interface

Le `Dockerfile` situé à la racine du dépôt construit une image Linux x64 pour la CI et les serveurs. Son point d'entrée est `mercury` et son verbe par défaut est `run`, si bien que l'image exécute un prompt sur une arborescence montée et sort avec le code de l'exécution :

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

L'image contient le bundle, son runtime Node 24 (dans `PATH`), les outils vendorisés de recherche, de shell, de débogage, de langage et d'image, `git` et le magasin de certificats ; il n'y a ni écran d'entrée ni flux de connexion. Elle s'exécute sous l'utilisateur non root `mercury`, avec son répertoire de configuration dans le conteneur (`MERCURY_CONFIG_DIR`), et `/work` est son répertoire de travail. La couleur et la souris suivent la détection de terminal propre au produit, et `--user 0` exécute en root avec la notice sovereign unique décrite plus haut.

Une clé de fournisseur est transmise comme variable d'environnement, sous les mêmes noms que ceux que le produit lit partout : `ANTHROPIC_API_KEY` ou `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` ou `GOOGLE_API_KEY`, `XAI_API_KEY` (et `XAI_MANAGEMENT_API_KEY` pour son compteur d'utilisation), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (et `MISTRAL_ADMIN_API_KEY` pour son compteur d'organisation), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` ou `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` ou `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` ou `META_API_KEY`, `MERCURY_COMPAT_API_KEY` pour un point de terminaison personnalisé compatible OpenAI, et `MERCURY_LOCAL_API_KEY` pour un serveur local. Sans clé, l'exécution refuse en une ligne et sort avec le code 1. `docker run -i … mercury run -` lit le prompt depuis stdin.

### Héberger une session

`mercury runner` sert une session à un hôte via stdio : JSON-RPC 2.0, un message par ligne. L'hôte envoie d'abord `initialize` et attend la réponse avant d'envoyer du travail :

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

Le nom et la version de l'hôte sont transmis sous `host` ; `capabilities` déclare `holds_asks`, `elicitation` et `partial_rows`. Chaque `id` de requête est un entier positif : une requête dont l'`id` est autre chose reçoit la réponse `-32600` avec `id: null`, donc numérotez les requêtes à partir de 1.

`queue/add` accepte le même objet prompt, shell ou note que l'entrée de ligne décrite plus haut. La sortie arrive dans des notifications `row`. `session/facts` lit l'état de la session ; `session/set_mode` change immédiatement le mode d'autorisation ; `session/set_model` et `session/set_effort` modifient le modèle et l'effort, et une modification faite pendant qu'un tour est en cours est retenue jusqu'à la fin de ce tour : elle répond avec `at: "turn_end"`, puis `session/applied` l'annonce. `turn/interrupt` interrompt un tour ; fermez stdin pour terminer la session.

Les demandes d'autorisation arrivent sous forme de `permission/request`, avec `kind: "tool"` ou `kind: "network"`. L'hôte répond par `outcome: "allow"` ou `outcome: "deny"` ; une réponse allow peut porter un `input` modifié et des `rules` d'autorisation. Une demande retirée envoie `$/cancel_request` avec son `request_id`. `holds_asks` confie à l'hôte la gestion du délai de la demande. Une question MCP n'utilise `elicitation/request` que si l'hôte déclare `elicitation` ; sinon elle reçoit la réponse `cancel`.

Une méthode inconnue reçoit la réponse `-32601`, des paramètres invalides `-32602`, un `id` qui n'est pas un entier positif `-32600`, et une requête reçue avant l'initialisation `-32002`. Un refus de règle renvoie `-32010`, avec une phrase dans `error.message` et une raison dans `error.data.kind`, telle que `mode`, `model`, `effort` ou `claim`. L'exécuteur répond à une ligne mal formée par `-32700` et poursuit ; trois lignes mal formées consécutives y mettent fin.

### Autres commandes

Les commandes disponibles comprennent :

- **`mercury health`** : rapport de diagnostic, aussi appelé certificat de santé. `--json` renvoie le rapport complet, `--deep` lance l'inventaire approfondi, et `--fix` lance les corrections guidées.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`** : se connecter (`login [<family>]`), lister les familles de fournisseurs (`list`), vérifier si un compte est connecté (`status [<family>]`), se déconnecter (`logout [<family>]`), ou générer un token Anthropic de longue durée (`mint`).
- **`mercury models [--json]`** : affiche les modèles accessibles aux comptes connectés (les mêmes informations que `mercury://models`).
- **`mercury mcp`** : gère les serveurs MCP avec `add`, `import`, `list`, `get`, `remove`, `trust-reset` et `serve`.
- **`mercury extensions`** : installe des extensions et gère leurs sources. Actions : `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` et `scaffold`.
- **`mercury roster`** : liste l'inventaire des agents.
- **`mercury usage`** : affiche la ligne compacte de chiffres qu'affiche l'écran `/usage` ; `--json` affiche la lecture complète : pour chaque fournisseur connecté, ses fenêtres avec le consommé et la réinitialisation, les chiffres et crédits qu'il a indiqués, chacun avec sa source et son âge, ainsi que la dépense de session par modèle, lue de la même façon que l'écran (le lecteur de chaque fournisseur connecté est échantillonné une fois, comme à l'ouverture).
- **`mercury daemon run|status|stop|restart`** : lance, inspecte, arrête ou redémarre le démon en arrière-plan. Ses emplacements de session sont des processus enfants `mercury runner` ; le démon envoie leurs prompts et héberge leurs demandes d'autorisation.
- **`mercury sessions list`** (aussi `mercury sessions` seul) : liste les sessions enregistrées de ce projet, de la plus récente à la plus ancienne : l'identifiant, la date de la dernière écriture, sa taille, `live` lorsque le démon l'héberge maintenant, et son titre ou son premier prompt ; `--all` lit tous les projets, `--limit <n>` borne la liste. L'identifiant est celui que `mercury --resume <id>` rouvre et que `sessions delete` supprime.
- **`mercury sessions delete <id>`** : supprime volontairement une session enregistrée — sa transcription et les enregistrements conservés à côté (reçus, instantané de reprise) — après une question ; `--yes` passe la question pour les scripts. Une session que le démon héberge maintenant est refusée, et un identifiant inconnu est refusé avec une indication vers l'inventaire (`/sessions` dans Mercury). Les sessions enregistrées ne sont par ailleurs jamais supprimées d'elles-mêmes.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`** : exécute un ordinateur local ou SSH en serveur de modèles pour toutes les sessions partageant le répertoire de configuration (`compat/box-<name>/<model>`), en utilisant une banque de poids locale vérifiée ou un téléchargement confirmé. Voir [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** et **`mercury lsp install <server>`** : le catalogue des serveurs de langage, chaque serveur étant installé (avec son binaire) ou absent (avec son remède d'installation) ; `install` affiche le remède d'un serveur, demande confirmation, exécute exactement ce remède (`--yes` passe la question pour les scripts) et indique où le binaire a été placé. Un serveur inconnu est refusé avec l'inventaire. Mercury n'installe jamais de serveur de langage de sa propre initiative ; l'ouverture d'un fichier ne démarre qu'un serveur déjà installé.
- **`mercury acp`** : sert un éditeur via l'Agent Client Protocol, avec un processus enfant runner pour chaque session. `mercury bridge install` installe l'extension VS Code ; `mercury bridge status` la vérifie ; `mercury bridge uninstall` la supprime.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`** : gère les tâches du moteur pour le projet Godot du répertoire courant. Mercury exécute les suites sur ses propres workers sans interface, à partir d'une copie figée du projet. Le service comprend un contrôle de compilation, des captures, des statistiques d'images, des profils finalisés, l'accès à la file de tâches, l'annulation et les résultats par identifiant. Voir [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`** : affiche une image dans le terminal.
- **`mercury install`** et **`mercury update`** (alias `upgrade`) : installe ou met à jour les archives de version ; avec `--json`, le document est sur stdout quel que soit le verdict, et le code de sortie indique s'il a échoué. Voir [Installation](#installation).
- **`mercury version`** et **`mercury help [command]`** : affiche la ligne de version ou une page d'aide, comme `--version` et `--help` ; aucune des deux ne démarre une session.

## Ce qui est inclus : mémoire RAG Mneme, LSP, AST pour 23 langages, débogueur DAP, recherche web et passerelles

- **Mémoire de projet RAG hybride Mneme.** Mneme est activée par défaut et conserve les faits de chaque projet dans des pages thématiques en markdown brut (`Retain`, `Recall`, `Reflect`, `Correct`). Recall fusionne un modèle d'embeddings sémantiques BGE de 118 Mo, qui s'exécute sur l'appareil (`bge-base-en-v1.5` `q8_0`, licence MIT, inclus dans chaque archive de version et compilé pour sa plateforme ; voir [Composants facultatifs](#composants-facultatifs)), avec un classement par mots BM25 avec racinisation, une pondération selon la récence et un suivi des citations par fusion réciproque des rangs (`k = 60`). Les règles épinglées (`pin: true`) se chargent mot pour mot sur l'étagère épinglée et ne changent que sur votre instruction. Au démarrage de la session, Mercury évalue les faits non épinglés et les notes antérieures par rapport à votre branche courante, aux fichiers touchés récemment et à la note de passation de la dernière session, dans une enveloppe de démarrage dédiée (`memory.startLimit`, 4 000 caractères par défaut). Les contrôles de contradiction à l'écriture repèrent les inversions de polarité, de négation et de nombre avant qu'un fait en conflit ne soit enregistré. Chaque session rédige à sa sortie une note de passation, dans ses propres mots, destinée à la page d'entrée de la session suivante, ainsi qu'une entrée de journal de session facultative. `/memory` ouvre le centre de mémoire, et `/memory page` dessine la bibliothèque dans votre navigateur sous forme de graphe de nœuds et d'arêtes. Voir [docs/MNEME.md](../MNEME.md).
- **Intelligence de code LSP, réécritures AST pour 23 langages, débogueur DAP et cellules `Eval`.** Lectures ancrées et modifications atomiques sur plusieurs fichiers (`ChangeSet`) ; requêtes vers le serveur de langage (`LspRead`) et refactorisations prévisualisées puis appliquées (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`) ; recherche et réécriture dans l'arbre syntaxique (`AstSearch`, `AstEdit`) avec les méta-variables `$NAME` et `$$$NAME` sur 23 grammaires dans les archives de version (16 dans chaque compilation `bun install` plus 7 dans le pack de grammaires) ; cellules de code persistantes en Python (`python3`) et en JavaScript (module ES de Node) (`Eval`) ; et un débogueur Debug Adapter Protocol (`Debug`) qui pilote `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, l'adaptateur de débogage du SDK Dart, `kotlin-debug-adapter`, l'adaptateur de débogage elixir-ls et Godot. L'outil `Test`, par son opération `debug`, fait entrer pas à pas un test Python (`pytest`, `unittest`), JavaScript/TypeScript (`node-test`, `vitest`, `jest`), Go (`go test`) ou Rust (`cargo test`) en échec directement dans une session `Debug`. Voir [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [transactions de modification](../CHANGE-TRANSACTIONS.md), [motifs structurels](../STRUCTURAL-PATTERNS.md), [cellules de code](../EVAL.md) et [le débogueur](../DEBUGGER.md).
- **`WebSearch` sans clé et `WebFetch` en markdown.** `WebSearch` suit une cascade unique : d'abord la recherche en direct native du fournisseur lorsque le modèle de la session la prend en charge (`ProviderSearch`), puis les clés Brave ou Tavily enregistrées, puis les API officielles choisies selon la forme de la requête (Stack Exchange, npm, PyPI, crates.io, la recherche de code GitHub, Hacker News Algolia, Wikipedia), puis les API JSON SearXNG configurées (`MERCURY_SEARCH_SEARXNG_INSTANCES`), et enfin le scraping de pages DuckDuckGo sans clé (activé par défaut ; désactivez-le dans `/config` ou avec `MERCURY_SEARCH_KEYLESS=0`). Chaque réponse reste sous 2 000 tokens et nomme la source qui a répondu. `WebFetch` lit les pages publiques au format markdown, dans les propres mots de la page, dans une limite de 38 000 caractères par appel (une page qui nécessite un navigateur est lue via le lecteur hébergé `r.jina.ai`, sauf si `MERCURY_FETCH_READER=0`, et une adresse de réseau privé n'y est jamais envoyée). Voir [docs/ENGINES.md](../ENGINES.md).
- **Agents, crewmates entre fournisseurs (`Crewmate`), worktrees et baux de fichiers.** Deux agents intégrés (`mercury-crew` pour le travail délégué de toute nature et `mercury-scout` pour la reconnaissance en lecture seule) se trouvent à côté des définitions d'agents que vous créez dans `/agents`. Lancez des crewmates sur n'importe quel fournisseur connecté, isolez le travail parallèle dans des copies de travail `git worktree` (`isolation: "worktree"`), coordonnez les fichiers partagés avec des baux de fichiers de projet intégrés au processus (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), et pilotez ou reprenez des crewmates par nom ou identifiant avec `SendMessage` et `ResumeCrewmate`. Suivez les crewmates et les exécutions de workflows dans `/crewmates` et `/runs`. Voir [docs/CREW.md](../CREW.md).
- **Utilisation de l'ordinateur de bureau.** Activée par défaut lorsque le pilote de bureau natif est disponible. L'outil `Computer` prend des captures d'écran et contrôle la souris et le clavier dans l'application au premier plan. Mercury vérifie l'application par son nom et son identité avant d'agir, demande une approbation, sauf si vos règles d'autorisation, votre autorisation de session, votre réglage d'accès ou votre mode d'autorisation autorisent déjà l'action, s'arrête sur `Esc`, ne laisse qu'une seule session contrôler le bureau à la fois, et tient les captures d'écran à l'écart du fichier de conversation enregistré. Définissez `MERCURY_COMPUTER_USE=0` pour retirer l'outil. Voir [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Saisie vocale Whisper sur l'appareil (`/voice`).** `/voice on` télécharge le modèle de parole anglais de 60 Mo (`base.en-q5_1`) à la première utilisation, vérifie son empreinte SHA-256 et active la dictée ; `/voice off` la désactive. Maintenez la barre d'espace pendant 1 s pour parler et relâchez pour arrêter, ou lancez `/voice` seul pour démarrer et arrêter une prise pendant que la voix est active. Whisper transcrit sur l'appareil, de sorte que l'audio vocal ne quitte jamais la machine, et `MERCURY_WHISPER_MODEL` sélectionne `tiny.en-q5_1`, `small.en-q5_1`, le modèle multilingue `base-q5_1`, ou un fichier `.gguf` local. Voir [docs/VOICE.md](../VOICE.md).
- **Cron et planificateur de sessions Saturn (`/saturn`).** Planifiez un prompt pour une session existante (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) ou planifiez une nouvelle session pour qu'elle démarre à une heure donnée. Les planifications peuvent s'exécuter une seule fois ou se répéter. Voir [docs/SATURN.md](../SATURN.md).
- **Passerelles VS Code (ACP), Unity, Blender, Godot et Aseprite.** `mercury acp` se connecte aux éditeurs qui prennent en charge l'Agent Client Protocol. L'extension VS Code (`mercury bridge install`) fait fonctionner Mercury dans l'éditeur via ce protocole : conversation, sessions, agents, artefacts et relectures, la sélection et les diagnostics de l'éditeur voyageant avec chaque prompt. Des intégrations distinctes, à activer explicitement, se connectent aux éditeurs Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) et Godot (`MERCURY_GODOT_TOOLS=1`) lorsqu'ils sont ouverts, avec un accès par lots à Aseprite (`MERCURY_ASEPRITE=1`). Voir [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) et [Aseprite](../ASEPRITE-BRIDGE.md).
- **Extensions.** Chaque extension possède un seul manifeste. Ajoutez des sources depuis une URL git, un dossier local ou une archive, approuvées par le hachage de leurs contributions. Voir [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Configuration par dépôt de ce que chargent les sessions, avec des préréglages nommés et des commandes que vous pouvez modifier pendant une session. Voir [docs/KIT.md](../KIT.md).
- **Diagnostics.** Le contrôle de santé et `/health` produisent un rapport appuyé sur des preuves de diagnostic, avec un verdict `certified`, `caution` ou `fault`, et des corrections vérifiées. Voir [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Confiance et autorisations.** Confiance dans l'espace de travail, règles et modes d'autorisation, et commandes que chaque session refuse. Voir [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, l'entretien de spécification : répondez aux questions de l'agent pour compléter la spécification qu'il utilisera pour construire un prototype. Voir [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Récupération.** Publication atomique, opérations journalisées et réconciliation au démarrage. Voir [docs/DURABILITY.md](../DURABILITY.md).

Les options d'exécution sont définies dans `src/substrate/flagRegistry.ts`, exposées comme réglages `MERCURY_*` et rendues à la demande. La compatibilité des intégrations est documentée dans [docs/COMPATIBILITY.md](../COMPATIBILITY.md). L'index complet de la documentation est [docs/README.md](../README.md).

## Commandes slash

`/help` liste les commandes interactives disponibles. Utilisez `/palette` pour une recherche floue de commandes. Le tableau ci-dessous regroupe les commandes intégrées activées par défaut selon les catégories utilisées dans `/help` ; la liste en direct inclut aussi `/samples` sous `current work` lorsque Samples est activé (`MERCURY_SAMPLES=1` ou la ligne Samples du Boot Menu), `/showcase` lorsque `MERCURY_DEV_SURFACES=1` est défini, ainsi que les skills et les commandes d'extension.

| Domaine | Commandes |
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

| Commande | Ce qu'elle fait |
| --- | --- |
| `/llmhost` | Choisissez un modèle à louer chez Runpod, Vast.ai ou Lambda, à exécuter sur votre propre ordinateur, ou à connecter à un serveur existant. |
| `/restart` | Déplace cette conversation vers la version de Mercury installée ; les surveillances en cours et les shells d'arrière-plan s'arrêtent. |
| `/mcp` | Inspectez les serveurs, connectez-vous, parcourez les outils et paramètres de chaque serveur, reconnectez-vous ou activez ou désactivez un serveur pour cette conversation. |

`/mouse off` rend le pointeur au terminal pour la sélection et la copie de texte natives. La préférence est enregistrée et apparaît dans `/config` sous le nom Mouse capture.

Un argument obligatoire commence par `<…>` dans l'usage d'une skill. Par exemple, `/update-config` et `/debug` nécessitent un argument. Si vous l'envoyez seule, la commande affiche sa description et son usage ; aucun tour ne démarre. Sélectionnez-la dans la complétion et Enter laisse `/name ` prêt pour que vous ajoutiez l'argument. `/loop` n'a pas d'argument obligatoire et s'exécute immédiatement.

## Signaler un problème

Pour un signalement court, utilisez [le formulaire de test](https://mercury-cli.ai/report) ou `/bug --short <what you tried>` dans Mercury. Il demande votre système d'exploitation, ce que vous avez essayé et ce qui a cassé ; aucun export de santé n'est nécessaire.

Exécutez `/bug <what happened>` dans Mercury pour prévisualiser un rapport avant de le déposer via la GitHub CLI (`gh`) connectée. Sans `gh`, Mercury enregistre un brouillon local dans le répertoire de configuration et vous indique la page des issues du dépôt.

Vous pouvez aussi ouvrir une issue directement avec le modèle bug, fournisseur/modèle ou demande de fonctionnalité. Indiquez la sortie de `--version`, votre système, votre terminal et les étapes exactes. Les rapports de bug et de fournisseur nécessitent aussi `mercury health --json`, ou `node dist/mercury.mjs health --json` pour une compilation depuis les sources. Une transcription de l'écran en échec aide.

Signalez les problèmes de sécurité en privé, via l'onglet Security du dépôt. Ne les publiez pas dans les issues publiques. Voir [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) couvre les issues, les pull requests et les vérifications.

## Licence

Mercury CLI est placé sous la licence Apache 2.0 (`Apache-2.0`), qui figure dans [LICENSE.md](../../LICENSE.md). Les SDK TypeScript et Python situés dans [sdk/](../../sdk/) et [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` sur npm et PyPI) sont également placés sous la licence Apache 2.0 (`Apache-2.0`), chacun par le fichier LICENSE qu'il contient ([sdk/LICENSE](../../sdk/LICENSE) et [sdk-py/LICENSE](../../sdk-py/LICENSE)).

L'usage du nom et des marques Mercury relève de la [politique de marque](../../TRADEMARKS.md). Les licences tierces incluses sont listées dans [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
