[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, paquete de npm `mercury-tech-cli`) ejecuta agentes de programación con IA en su terminal, dentro de sus propios repositorios git en macOS, Linux y Windows.

Sitio web: [mercury-cli.ai](https://mercury-cli.ai) · Repositorio: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

Un agente lee y edita archivos, ejecuta comandos de shell, recorre pruebas y depuradores paso a paso, y comprueba los resultados. Usted elige el proveedor del modelo, el modelo y lo que el agente tiene permitido hacer:

- **Concourse multisesión y worktrees aislados:** ejecute varias sesiones a la vez en el Session Concourse (`/concourse`) y delegue trabajo en paralelo en crewmates de distintos proveedores (`Crewmate`), en copias de `git worktree` aisladas y con reservas de archivos del proyecto, para que los agentes en paralelo no se sobrescriban entre sí.
- **20 proveedores de modelos, `/llmhost` y `/localsetup`:** mantenga los 20 proveedores con sesión iniciada a la vez (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI) y cambie de proveedor y de modelo durante el chat. Abra `/llmhost` para elegir un modelo, revisar su cuantización, la división `conversations × context` y el nivel de razonamiento, y ejecutarlo en una GPU alquilada (Runpod, Vast.ai o Lambda), en su propio equipo (`mercury host`) o en un servidor existente. O ejecute `/localsetup` para instalar o conectar Ollama junto con LM Studio, vLLM y llama.cpp.
- **Memoria de proyecto RAG híbrida Mneme:** usa un modelo de embeddings semánticos BGE de 118 MB que se ejecuta en el propio dispositivo (`bge-base-en-v1.5`), con ranking de palabras BM25, seguimiento de citas, reglas fijadas literales, contexto de inicio según la rama, comprobaciones de contradicciones al guardar, notas de traspaso entre sesiones y el grafo de navegador de `/memory page`.
- **Herramientas de compilador, AST y depuración DAP:** conecta la inteligencia de código LSP y refactorizaciones con vista previa (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), búsqueda y reescritura estructural con AST en 23 lenguajes mediante tree-sitter (`AstSearch`, `AstEdit`), un depurador integrado de Debug Adapter Protocol (`Debug`) que usa `debugpy`, `js-debug`, `lldb`, `gdb` y `dlv` para avanzar paso a paso por pruebas fallidas de Python, Node, Go y Rust, y celdas `Eval` persistentes de Python y JavaScript.
- **`WebSearch` sin clave y `WebFetch` en markdown:** busca a través de la búsqueda nativa del proveedor, de claves de Brave o Tavily, de APIs oficiales (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), de SearXNG y de DuckDuckGo sin clave, y obtiene documentación pública en markdown dentro de un presupuesto de 38.000 caracteres por llamada.
- **Control del escritorio, voz con Whisper, programación con Saturn e integraciones con editores:** controla aplicaciones de escritorio (`Computer`), transcribe el dictado por voz de pulsar para hablar en el propio dispositivo con Whisper (`/voice`), programa sesiones recurrentes o de una sola vez con Saturn (`/saturn`) y se conecta con VS Code mediante el Agent Client Protocol (`mercury acp`), junto con Unity, Blender, Godot y Aseprite.
- **Generación de video (`Video`):** envía prompts y archivos de referencia del proyecto a un generador de MiniMax configurado ([docs/VIDEO.md](../VIDEO.md)) y guarda en su proyecto el MP4 generado y, de forma opcional, un fotograma PNG de vista previa de 1 segundo.

Mercury se usa para desarrollar Mercury, con varias sesiones y modelos en tareas largas. Seguir la pista de ese trabajo es lo difícil: qué sigue en ejecución, qué ha cambiado y qué necesita una decisión. Cada sesión escribe su propia nota de traspaso al terminar, y la siguiente sesión lee esa nota una vez al iniciarse, junto con mis reglas fijadas, lo que evita que el contexto se contamine entre sesiones.

![Un prompt al coordinador en el tablero de sesiones lanza dos sesiones, cada una en su propio worktree; una pregunta antes de editar y ambas terminan con sus cambios listos para revisar](../media/session-board-stream.gif)

Mercury es de código abierto bajo la Apache License 2.0, al igual que los SDK en [sdk/](../../sdk/) y [sdk-py/](../../sdk-py/).

## Instalación

Los archivos de versión están disponibles para Mac con Apple silicon e Intel, Linux x64 y arm64, y Windows x64 y arm64. Instale `git` por separado; cada archivo incluye Node y ripgrep, así que no hace falta instalar Node aparte.

Elija un método de instalación:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS y Linux (x64 y arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 y arm64), en PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS y Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` es el mismo paquete
mise use -g npm:mercury-tech-cli                   # mise, mediante el paquete de npm
```

Las direcciones de instalación llevan recuentos aproximados de solicitudes de script por origen y por día UTC (las instalaciones completadas no se cuentan); el contador no guarda ninguna dirección IP, cadena de user-agent ni cookie.

Abra una terminal nueva, o ejecute la línea `export PATH=…` que imprime el instalador de shell, y después ejecute `mercury --version` para comprobarlo y `mercury` desde un repositorio para iniciar la [primera ejecución](#la-primera-ejecución). En Windows PowerShell, y tras una instalación con Homebrew, npm, bun o mise, `mercury` funciona en la misma terminal.

<details>
<summary>Rutas de instalación, actualizaciones y verificación de versiones</summary>

### Diferencias entre los métodos de instalación

Los instaladores de shell y de PowerShell descargan la versión más reciente para su plataforma, comprueban su SHA-256 con `SHA256SUMS.txt`, la descomprimen y ejecutan el comando `mercury install` que trae el propio archivo.

Homebrew y el paquete de npm están fijados cada uno a una versión concreta y se publican de nuevo tras cada tag, así que pueden ir por detrás de la versión más reciente. Los comandos de Homebrew usan el nombre completo del tap `Whq02/mercury/mercury` (el `mercury` a secas en `homebrew-core` es otro programa). El paquete de npm, `mercury-tech-cli`, es un lanzador que descarga su versión fijada; mise instala ese mismo paquete. `mercury install --uninstall` elimina la versión instalada y el shim del comando, pero conserva su configuración y sus sesiones (si instaló el lanzador de npm, ejecute también `npm uninstall -g mercury-tech-cli`).

La instalación de Mercury es local para el usuario y no requiere acceso de administrador. Puede volver a ejecutar un comando de instalación sin riesgo.

### Rutas de instalación

Las versiones publicadas se guardan en el directorio de configuración, en `~/.mercury/versions/<version>` (`%USERPROFILE%\.mercury\versions` en Windows). El comando `mercury` se instala en `~/.local/bin` en macOS y Linux, o en `%LOCALAPPDATA%\Mercury\bin` en Windows.

`mercury install` añade el directorio del comando a PATH una sola vez: una línea protegida en el archivo de inicio de su shell, o una entrada en el PATH de usuario de Windows. Una terminal nueva recoge el cambio automáticamente.

### Actualizaciones

Use `mercury update` con cualquier método de instalación.

En una instalación hecha con el instalador de shell o de PowerShell, o con `mercury install`, actualiza Mercury en el mismo sitio. `--check` busca actualizaciones, `--status` informa del estado de la actualización y `--rollback` vuelve a la versión anterior, que se conserva en disco.

Con Homebrew, pregunta antes de ejecutar `brew upgrade Whq02/mercury/mercury`. La respuesta predeterminada es no; escriba `y` para aprobar. Mercury muestra la salida del comando en tiempo real y comprueba la versión instalada al terminar. Use `--yes` para omitir la pregunta en los scripts.

El lanzador de npm usa la misma estructura de versiones que los instaladores y delega cada ejecución en la versión instalada. Por eso, `mercury update` actualiza una instalación de npm en el mismo sitio, a través del canal de actualización propio de Mercury. `npm update -g mercury-tech-cli` solo cambia la versión que el paquete instala en su primera ejecución. Esto también vale cuando se usa mise.

`--check` lee la misma lista de versiones para todos los métodos de instalación y le indica cómo actualizar su instalación. Cuando hay una actualización disponible, la pantalla de inicio muestra `vX.Y.Z available · mercury update` una vez en la esquina inferior derecha, y el chat muestra el mismo aviso hasta que actualice. Defina `MERCURY_UPDATE_NOTICE=0` para ocultar ambos.

Las solicitudes de instalación y actualización descargan de forma anónima la lista pública de versiones y los archivos, así que puede ejecutarlas sin cuenta ni token. Si una solicitud anónima es rechazada, Mercury consulta la GitHub CLI (`gh`) con la sesión iniciada.

Tras una actualización, Mercury comprueba si el comando de su PATH apunta a la instalación actualizada. Si otra instalación tiene prioridad, o si el comando actualizado no está en PATH, explica el problema y cómo solucionarlo. `mercury health` informa del mismo problema.

### Verificación de versiones

Antes de activar una versión, Mercury comprueba su archivo con `SHA256SUMS.txt`. También exige un contenido firmado con la clave de firma de versiones de Mercury incluida en su lista de confianza integrada, antes de preparar la actualización. Una firma rechazada deja sin cambios la instalación activa.

Use `--allow-unsigned` para aceptar un contenido sin firmar. Mercury sigue rechazando las claves de firma desconocidas, los bloques de firma mal formados y el contenido manipulado. El resultado del comando y su registro local muestran que usted permitió un contenido sin firmar.

A partir de 1.0.0-beta.3, los archivos se firman durante el empaquetado y sus firmas se verifican antes de la publicación. Una instalación verificada no muestra ningún aviso de firma al iniciarse. `mercury health` informa de la clave de firma `627b54b734ca0e72`.

Los archivos de 1.0.0-beta.2 no están firmados. Estas instalaciones informan una vez por instalación de que su procedencia no está firmada cuando inicia Mercury de forma interactiva, sin comando ni opción. La comprobación de estado sigue mostrando ese estado. Significa que el manifiesto del archivo no tiene firma; la descarga se sigue comprobando frente a `SHA256SUMS.txt`.

[docs/TRUST.md](../TRUST.md) explica los resultados de la verificación y cómo comprobar un archivo manualmente. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) trata la verificación al iniciarse.

### Notas sobre plataformas

Hay archivos de versión para todas las plataformas indicadas arriba. Cualquier otra máquina se compila desde el código fuente.

Los archivos para Mac Intel están disponibles desde 1.0.0-beta.3. Se empaquetan de forma cruzada en un runner de Apple silicon y se prueban al iniciarse con Rosetta antes de la publicación. Los Mac Intel que usen 1.0.0-beta.2 necesitan una compilación desde el código fuente.

</details>

## Requisitos

Los archivos de versión incluyen Node 24 LTS. El lanzador, `mercury install` y `mercury update` usan ese entorno de ejecución incluido; `git` es el único requisito aparte para la propia versión.

Para compilar desde el código fuente necesita:

- **Node 24 LTS**, en el rango compatible `>=24.20.0 <25`. `.node-version` fija la revisión que se usa para las compilaciones y que se incluye en los archivos de versión.
- **bun 1.3.x** para la compilación. No viene incluido en las versiones.
- **git**. En Windows, ejecute PowerShell 7 dentro de Windows Terminal o de la terminal de VS Code. Consulte [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

La versión mínima de Node incluye la corrección de nodejs/node#56645. Por debajo de 24.20.0, los comandos `run` headless que llaman a una herramienta se abortan al salir en Windows.

Los lanzadores eligen Node en este orden: el binario indicado en `MERCURY_NODE`, el entorno de ejecución incluido y, después, una instalación de Node compatible en PATH. Si falta el entorno de ejecución, el lanzador muestra un error.

### Shells de Windows

Los archivos de versión incluyen el motor de shell compatible con bash de Mercury (`brush`), y en Windows es el que atiende la herramienta Bash de forma predeterminada: encuentra un programa `.cmd` o `.bat`, como `npm`, por su nombre simple mediante PATHEXT, pasa `%VAR%` y `^` a un archivo por lotes sin cambios, ejecuta un programa indicado con una ruta relativa tras `cd` y mantiene el estado del shell entre llamadas. No hace falta el `bash.exe` de Git para Windows; si está instalado, `MERCURY_SHELL_ENGINE=system`, o `system` en `/config` bajo Shell engine, hace que la herramienta Bash use solo `bash.exe`.

Lea la fila `shell` de la comprobación de estado para ver qué shell está activo y por qué: el motor incluido (el predeterminado en Windows, o activado por la fijación o la configuración), o Git Bash cuando el motor está desactivado o falta su paquete.

En macOS y Linux, el shell del sistema es el predeterminado; defina `MERCURY_SHELL_ENGINE=brush` o elija `brush` en `/config`, bajo Shell engine, para que la herramienta Bash use también allí el motor incluido, con estado de shell persistente.

Una compilación desde el código fuente sin el paquete del motor ni Git para Windows sigue arrancando, pero la herramienta Bash no está disponible. La herramienta PowerShell sigue disponible, y el diagnóstico `shell` explica cómo restaurar la compatibilidad con Bash.

## Compilar desde el código fuente

Mercury se compila con bun y se ejecuta en Node 24 LTS. Instale [los requisitos para compilar desde el código fuente](#requisitos), incluido bun 1.3.x:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS y Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, en PowerShell 7
bun --version                                      # 1.3.x
```

Después, en un clon de este repositorio:

```sh
bun run setup                      # una vez; bun install + los paquetes incluidos
bun run build.ts                   # escribe dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Compatibilidad con terminales

La interfaz de pantalla completa necesita una TTY real, pero no tiene un tamaño mínimo de terminal. El diseño completo empieza en 100 columnas por 26 filas; las ventanas más pequeñas usan un diseño compacto.

Mercury usa color de 24 bits cuando la terminal anuncia compatibilidad mediante `COLORTERM=truecolor` o se reconoce como iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal o VS Code. Las demás terminales usan 256 colores, incluido Terminal de Apple en macOS 15 y anteriores.

La fila Terminal color de la comprobación de estado indica la profundidad detectada y el motivo. Defina `MERCURY_TRUECOLOR=1` para una terminal que admite color verdadero pero no lo anuncia, o `MERCURY_TRUECOLOR=0` para forzar 256 colores.

### Componentes opcionales

`setup` descarga los paquetes de capacidades incluidos: pyright, debugpy, js-debug, gramáticas adicionales, el entorno de ejecución de Node de la plataforma y brush. Si una descarga falla, ese paquete se omite y la compilación y las herramientas afectadas informan del componente que falta. Ejecutar `bun install` por sí solo produce una compilación sin esos paquetes.

Para compilar el soporte de voz, ejecute `setup` con Rust instalado. Eso compila `native/voice`. Añada cmake para compilar también `native/whisper`. Con Rust instalado, `setup` también compila el addon del controlador de escritorio (`native/desktop`), por el que funciona la herramienta `Computer`. Con Rust instalado, `setup` además compila el addon local de embeddings (`native/embed`, `bun run scripts/vendor/build-embed.ts`) y descarga el modelo BGE de 118 MB (`bun run scripts/vendor/fetch-embed-models.ts --default`); sin cargo, el paquete se omite, setup lo indica y la búsqueda en la memoria de Mneme se limita a la coincidencia de palabras. Cada archivo de versión incluye el paquete de embeddings compilado para su plataforma; en Linux y Windows, el cálculo usa un kernel vectorizado, de modo que un Recall por significado tarda alrededor de una décima de segundo (unas pocas centésimas en macOS, que usa Accelerate). Si una compilación nativa carece de sus herramientas, setup la omite y la comprobación de estado informa del addon que falta. El motor de shell de Windows también se compila en su equipo, porque upstream no tiene binario para Windows.

Consulte [Shells de Windows](#shells-de-windows) y [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) para el motor de shell `brush`.

La compilación escribe solo en `dist/`. La configuración y las sesiones se guardan en `~/.mercury`, o en el directorio que define `MERCURY_CONFIG_DIR`, y se crean en la primera ejecución. En Windows, ejecute `node dist\mercury.mjs` directamente.

### Instalar una compilación desde el código fuente como comando

`scripts/ops/deploy-runtime.sh` publica una compilación de un árbol limpio en una carpeta nueva `<config home>/runtime/builds/<build>` y hace que `runtime/current` apunte a ella (`runtime/dist` es el nombre anterior del mismo enlace). `scripts/ops/deploy-launcher.sh` instala el lanzador en `<config home>/bin/mercury`. Añada ese directorio a PATH; en zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

El lanzador se detiene con un error si falta el entorno de ejecución. No cambia a otra compilación. La selección de Node sigue el orden indicado en [Requisitos](#requisitos). Para una instalación de versión publicada, ejecute `mercury install` o `mercury update`, que no modifican las copias del código fuente; consulte [Actualizaciones](#actualizaciones).

[AGENTS.md](../../AGENTS.md) es la guía breve de compilación y ejecución. [BUILD-NOTES.md](../../BUILD-NOTES.md) trata la compilación con más detalle.

## La primera ejecución

En su primera ejecución interactiva, elija un aspecto y después inicie sesión con un proveedor. La pantalla muestra una vista previa de los cambios de tema mientras navega. True Black es el predeterminado; las otras opciones son el tema oscuro oasis y Black and white, que no aplica ningún color: usa el texto y el fondo propios de la terminal, tal como se ve Mercury en una terminal sin color. Puede cambiarlo más tarde con `/appearance`.

También puede elegir "sign in later" para explorar sin conectar una cuenta. Si una clave de proveedor de su entorno ya conecta un proveedor, no se pide el paso de inicio de sesión. A continuación, el paso Guardrails le recuerda que revise las ediciones y los comandos de Mercury, y que lo que lee puede llevar instrucciones para el modelo. En una terminal que Mercury sabe configurar (Terminal.app, la familia de VS Code, Alacritty, Zed), un paso Terminal keys puede configurar atajos de nueva línea en los ajustes propios de la terminal (en Terminal.app de macOS asigna `Option+Enter` a una nueva línea y silencia la campana de la terminal en todos los perfiles, lo que surte efecto al reiniciar Terminal.app; en la familia de VS Code, Alacritty y Zed escribe `Shift+Enter` para una nueva línea). Está desactivado salvo que lo elija, y se conserva una copia de seguridad.

A continuación, Mercury pregunta si confía en la carpeta que abrió. Nada que pida la configuración del espacio de trabajo se ejecuta antes de que usted conceda esa confianza. La concesión abarca todo el repositorio; si la rechaza, Mercury se cierra. Consulte [docs/TRUST.md](../TRUST.md).

Un inicio interactivo normal abre la pantalla de inicio. Tiene diez entradas de menú; Continue Last Session aparece solo cuando ya hay historial de sesiones:

- **New Session in \<folder\>** inicia una sesión nueva en la carpeta actual.
- **Continue Last Session** vuelve a su chat más reciente.
- **Boot Menu** configura las sesiones futuras, incluidos motion, crewmates y workflows.
- **MCPs & Skills** elige lo que carga la siguiente sesión. Consulte [docs/KIT.md](../KIT.md).
- **Agents** crea y edita agentes.
- **Health Check** comprueba la instalación.
- **Saturn Scheduler** programa sesiones. Consulte [docs/SATURN.md](../SATURN.md).
- **Logins** conecta las cuentas de proveedor.
- **Session Concourse** abre la lista de sesiones del proyecto actual.
- **Sessions · Projects** le permite elegir una sesión o un repositorio.

Las entradas de menú se abren sobre la pantalla de inicio, y `Esc` vuelve a la entrada seleccionada. La lista de sesiones se abre en una pantalla aparte, a la que también se llega con `Shift+→`. Un argumento de prompt, `--continue` o `--resume` le lleva directamente al chat.

### Motion, crewmates y workflows

La sección Performance del Boot Menu incluye un ajuste Motion: `auto`, `full`, `reduced` u `off`. Controla la animación en reposo de la interfaz y también está disponible en `/config`.

En Agents, los interruptores Crewmates y Workflows determinan si las sesiones nuevas reciben las herramientas Crewmate y Workflow. Al desactivar un interruptor se quita la herramienta correspondiente, y los intentos de lanzar ese tipo de trabajo devuelven la misma explicación. Dentro de una sesión, `/crewmates on|off` y `/workflows on|off` cambian el ajuste en el siguiente límite de turno.

## El bucle diario: Session Concourse, worktrees de git y crewmates

### Iniciar una sesión y aislar worktrees

Pulse `Enter` en New Session para crear una sesión en la carpeta actual con su modelo predeterminado. Mercury abre su chat y, al mismo tiempo, lo añade a la lista de sesiones. Mantiene un proceso preparado detrás del menú para reducir el trabajo de arranque.

Iniciar otra sesión no detiene la anterior. Puede dejar una tarea en ejecución y trabajar en otra cosa. Inicie con `--worktree [name]` (o pida un `worktree` en el chat para ejecutar `EnterWorktree`) para dar a una sesión su propia rama y su propia copia de trabajo bajo `.mercury/worktrees/`. Los crewmates en paralelo también pueden ejecutarse en worktrees aislados y coordinar los archivos compartidos con reservas de archivos del proyecto; consulte [Qué incluye](#qué-incluye-memoria-rag-de-mneme-lsp-ast-de-23-lenguajes-depurador-dap-búsqueda-web-e-integraciones) y [docs/CREW.md](../CREW.md).

### Trabajar en el chat

Describa el trabajo en lenguaje natural. El agente lee, edita, ejecuta y revisa el código según el modo de permisos que haya elegido. Las llamadas a herramientas aparecen mientras se ejecutan, como tarjetas compactas o con la salida completa. Elija la visualización en `/config`, en Tool output; el ajuste se guarda para los siguientes inicios.

Use `/model` y `/effort` para ajustar la sesión. `/permissions` controla qué puede ejecutarse sin aprobación y qué debe preguntar primero.

Revise los cambios con `/diff`, por origen, archivo y hunk. `! <command>` ejecuta un comando de shell en el chat, con las últimas líneas de salida en vivo. `/runs` muestra los shells y los crewmates en ejecución (`/tasks` abre el mismo tablero), y `/crewmates` abre la vista Crew en vivo. Entre turnos, `/clear` guarda el chat actual y abre una sesión nueva, y `/restart` traslada el chat a una compilación de Mercury recién instalada. `/title` le pone nombre al chat, y `/help` lista los comandos disponibles.

### Moverse entre pantallas

`Shift+←` y `Shift+→` se mueven entre las pantallas disponibles en ese momento. Un inicio nuevo muestra la pantalla de inicio y la lista de sesiones. La pantalla de chat se añade cuando se enfoca una sesión y se quita cuando se cierra el último chat. Las pistas de teclas muestran solo los movimientos disponibles.

Al cerrar todos los chats vuelve a la pantalla de inicio. Use `--chat` para tener solo la pantalla de inicio y el chat, sin la lista de sesiones. `--concourse-off` guarda esa preferencia para los siguientes inicios; `--concourse-on` o `/config` la vuelven a activar.

### Gestionar sesiones en el Session Concourse

Abra la lista de sesiones con `/concourse` o con `Shift+→` desde la pantalla de inicio. Muestra primero las sesiones en ejecución del proyecto actual, seguidas de los chats guardados que no están en ejecución, del más reciente al más antiguo.

Cada sesión en ejecución tiene una celda NOW con su actividad actual. Seleccione una fila y pulse `Enter` para volver al chat mientras las demás sesiones siguen en ejecución. Una sesión que falló se queda en la lista de sesiones como NEEDS YOU, con el motivo, hasta que la libere.

[docs/SESSIONS.md](../SESSIONS.md) trata el ciclo de vida de las sesiones.

## Proveedores y modelos: inicios de sesión, `/localsetup` y `/llmhost`

Use `/logins` para conectar un proveedor. Abre el mismo catálogo de inicio de sesión que se usa durante la configuración. `/accounts` gestiona después las ranuras de proveedor conectadas.

- **OpenAI:** suscripción de ChatGPT o clave de API.
- **Anthropic:** suscripción de Claude, inicio de sesión en Console o clave de API.
- **OpenRouter:** acceso al catálogo mediante OAuth o una clave de API; las solicitudes de modelo deniegan la recopilación de datos y exigen todos los parámetros desde el principio. `/config → OpenRouter routing policy` define las opciones de respaldo y de retención cero de datos; elija open para relajar la política y dejar el enrutamiento en manos de OpenRouter.
- **Google Gemini:** Sign in with Google, una clave de API o su propio cliente OAuth. Sign in with Google ejecuta Gemini con la cuota del plan que tiene la cuenta de Google (una cuenta gratuita, Google AI Pro o Google AI Ultra) a través del cliente Antigravity propio de Google: el prompt, los esquemas de herramientas y los resultados de las herramientas se envían al endpoint Code Assist de Google con ese cliente y la cuenta con sesión iniciada, y `/model` muestra la lista de modelos que Google sirve a la cuenta. Una clave de API o su propio cliente OAuth factura a un proyecto de Cloud.
- **Hugging Face:** inicio de sesión con código de dispositivo o token de Hub.
- **Kimi (Moonshot):** inicio de sesión con código de dispositivo o clave de API.
- **GLM (Z.AI):** una clave de GLM Coding Plan (suscripción) o una clave de API general de pago por uso. `/logins zai` guarda cualquiera de las dos y registra el plan; `ZAI_API_KEY` también funciona, con `ZAI_KEY_PLAN=coding|general` para indicar el plan (si no se define, Mercury lo lee de la propia lista de modelos de la clave).
- **DeepSeek:** una clave de API de la plataforma DeepSeek (`/logins deepseek` o `DEEPSEEK_API_KEY`).
- **xAI (Grok):** inicie sesión con su suscripción de Grok (SuperGrok / X Premium) o pegue una clave de API mediante `/logins xai`.
- **Meta (Muse):** Sign in with Meta (una suscripción de Muse Code, con un código de dispositivo en su navegador) o una clave de Model API de pago por uso. Sign in with Meta intercambia el código de dispositivo con los endpoints OIDC de Meta (`https://auth.meta.com/oidc/device/authorization/` y `/oidc/device/token/`) bajo el id de cliente público de Muse Code, envía el token de cuenta resultante una sola vez a `https://api.meta.ai/muse-code/key` para generar la clave de API de la suscripción (y en lecturas acotadas de `/usage` para el nivel del plan y sus ventanas de uso), y envía solo la clave generada en cada solicitud de modelo a `https://api.meta.ai/v1`. Una clave de Model API pegada, o `MODEL_API_KEY` / `META_API_KEY`, factura por uso.

- **Qwen:** una clave de QwenCloud (Token Plan o pago por uso) o una clave de Alibaba Cloud Model Studio (pago por uso, Token Plan o Coding Plan), comprobada en su propio endpoint antes de guardarse; una clave de plan muestra los modelos del plan, con Qwen3.8 Max primero.
- **MiniMax:** una clave de Open Platform o una clave de suscripción de M Plan.
- **Together AI** y **Cohere:** clave de API.
- **Groq**, **Cerebras** y **Fireworks AI:** clave de API; la clave de cualquier familia también puede obtenerse de un comando indicado en `credentials.keyCommands.<family>`.

Mistral, Nous Portal y OpenCode Zen también se conectan mediante `/logins`, con 20 familias de proveedores con inicio de sesión en total. Los servidores de modelos locales (Ollama, LM Studio, vLLM y llama.cpp) y los endpoints personalizados compatibles con OpenAI funcionan sin inicio de sesión de proveedor. Ejecute `/localsetup` para instalar o iniciar Ollama, descargar un modelo que quepa en su memoria, definir su ventana de contexto o conectar un servidor de LM Studio, vLLM o llama.cpp que ya esté en marcha ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Cada proveedor usa su propio protocolo, sus credenciales y su gestión de errores, y las solicitudes nunca pasan a otro proveedor. Consulte [docs/ENGINES.md](../ENGINES.md).

`/llmhost` enumera los modelos que puede alojar y muestra dónde puede ejecutarse cada uno en este momento: en una GPU alquilada a Runpod, Vast.ai o Lambda, en su propio equipo o en un equipo SSH guardado (`mercury host`), o en un servidor de modelos existente. Cada página de modelo muestra las opciones de cuantización, cómo se reparte el presupuesto de memoria de la GPU entre las conversaciones en paralelo (`conversations × context`) y el nivel de razonamiento predeterminado (que `/effort` cambia por solicitud). Los alquileres de GPU requieren una confirmación explícita del precio por hora, y la configuración sigue en segundo plano si cierra la ventana emergente. En Runpod también puede ajustar la calidad, las divisiones de contexto y el razonamiento antes de alquilar o en un pod en marcha (`Tune`), mantener los pesos en un volumen de carga rápida y definir alertas de stock con intervalo de 5 segundos. Los alquileres de Vast.ai y Lambda son nuevos en 1.0.0-beta.40 y se han verificado con las API publicadas de los proveedores mediante fixtures (no se realizaron ejecuciones reales de alquiler). Consulte [docs/LLM-HOST.md](../LLM-HOST.md).

Las sesiones nuevas usan el proveedor conectado más recientemente y el modelo más nuevo disponible para esa cuenta. Los modelos a los que la cuenta no puede acceder se omiten. Si ese proveedor no tiene ningún modelo utilizable, Mercury comprueba el siguiente proveedor conectado más recientemente. Esta elección se hace al iniciar la sesión; una solicitud fallida en una sesión existente se queda con su proveedor.

`/model` explica la selección. Una palabra de familia elige el modelo más nuevo de esa familia: `/model grok`, `/model deepseek`, `/model kimi` o `/model glm`. Si no hay ningún proveedor conectado, la pantalla de inicio y `/model` le dirigen a `/logins`. `/defaultprovider` le permite marcar explícitamente un proveedor como la opción más reciente.

El acceso a los proveedores sigue sujeto a las condiciones y a la disponibilidad propias de cada proveedor. La licencia de Mercury no las sustituye.

## La CLI headless: `mercury run`, Docker y el runner JSON-RPC

La misma compilación se ejecuta sin la interfaz interactiva. `node dist/mercury.mjs --help` lista todas las opciones.

`mercury run "<prompt>"` ejecuta un prompt sin interfaz de terminal:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` imprime la respuesta; el motivo de un turno fallido va a stderr.
- `json` imprime la última fila `outcome` como un único objeto JSON.
- `rows` escribe un objeto JSON por línea: `session`, después un `turn` y sus filas `text`, `reasoning`, `tool_call`, `tool_result` y `step`, y al final `outcome`. Las esperas, el progreso de las herramientas, las tareas en segundo plano y los avisos tienen sus propias filas. Cada fila lleva `seq`, `timestamp` y `session_id`; las filas de un turno también llevan su número `turn`. `seq` numera el flujo de esta ejecución desde 1; `turn` cuenta los turnos de la sesión, así que una ejecución que continúa una conversación guardada (`-c`, `-r`, `--fork`) numera su turno a partir de los ya existentes, y su fila `session` indica en `resume_of` la conversación que continúa.

Los tipos de fila de salida, según su campo `type`:

- `session`: la fila de apertura: `version`, `build` (los primeros doce caracteres hexadecimales del árbol desde el que se compiló el paquete, tal como lo muestra `mercury daemon status`; ausente cuando no hay un manifiesto junto al paquete), `resume_of` (en una ejecución continuada, el id de sesión de la conversación que continúa; es el mismo que `session_id` salvo que la ejecución se haya bifurcado), `cwd`, `model`, `mode`, `tools`, `mcp_servers`, `commands`, `agents`, `skills` y `extensions` de la sesión, y `tools_withheld` (presente cuando una regla de denegación oculta una herramienta por su nombre simple: en cada entrada, `tool`, `rule` y `source`).
- `turn`: un turno `started` o `waiting`, con su `turn_id`; `model`, `message_ids` y el recuento de `agents` cuando se conoce.
- `text`: un bloque de texto definitivo: `message_id`, `block`, `text` y su `phase` (`commentary` o `final_answer`).
- `reasoning`: un bloque de razonamiento definitivo: `message_id`, `block`, `text`, o `redacted: true`.
- `tool_call`: una llamada a herramienta: `call_id`, `tool`, `input`, con su `message_id` y `block`.
- `tool_result`: el resultado de la llamada: `call_id`, `status` (`ok`, `error`, `aborted` o `refused`) y `output`. Una llamada que el modelo formó tan mal que se rechazó antes de ejecutarse (una herramienta desconocida, argumentos que no son JSON válido o que no encajan con el esquema de la herramienta) también recibe su par: una fila `tool_call` con los argumentos tal como llegaron (`{}` cuando no eran un objeto) y una fila `tool_result` con status `refused` cuyo `output` es el motivo; después sigue el `notice` de corrección. Esa llamada nunca se ejecutó y no es una denegación.
- `tool_update`: progreso de una herramienta en ejecución: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` o `eval`) y cualquiera de `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` y `total` que informe la llamada. Una llamada de shell o de PowerShell emite un tick a medida que llega su salida (un comando que no imprime nada nunca emite ticks); una llamada MCP, cuando su servidor informa del progreso; una llamada Eval, mientras se ejecuta su celda; ninguna otra herramienta emite ticks; una llamada a Browser o a Crewmate no informa nada hasta su resultado.
- `step`: una llamada al modelo del hilo principal: `message_id`, `model`, `usage`, y `stop` cuando el modelo indica por qué se detuvo.
- `outcome`: el resultado del turno, descrito más abajo.
- `close`: la nota que deja para la siguiente sesión al cerrar: `state` (`stored`, `skipped` o `none`), `note_chars` y el `usage` de las llamadas al modelo que la escribieron, de modo que quien sume el uso de cada fila obtenga el del resultado. Con el prompt dado como argumento, la nota se pide dentro del último turno y `close` precede al `outcome` de ese turno; con `--input rows`, sigue al último `outcome` cuando stdin se cierra.
- `wait`: una espera del modelo: `state` (`first_byte`, `retry`, `silence`, `loading` o `done`) con las cifras que lleva ese estado, como `since_ms`, `attempt` y `of`, `delay_ms`, `reason` y `http_status`.
- `heartbeat`: el flujo del modelo dio señales de vida tras al menos un segundo sin un evento analizado: llegaron bytes que no produjeron ninguna fila. La fila no lleva nada más y aparece como máximo una vez por segundo; la frecuencia depende de la forma de streaming del proveedor, así que un flujo que nunca hace pausas entre eventos no emite ninguna.
- `compaction`: una compactación `started`, `progress` o `ended`: `trigger` (`manual`, `auto` o `overflow`), `stage`, `fill`, `summary_tokens` y, al final, `exit` (`landed`, `cancelled` o `failed`).
- `mode`: cambió el modo de permisos: `mode`.
- `rate_limit`: el estado de límite del proveedor: `status` (`allowed`, `warning` o `rejected`), `window`, `resets_at`, `utilization` y los campos de exceso.
- `task`: una tarea en segundo plano `started`, `progress` o `ended`: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` o `stopped`) y `output_file` a medida que se conocen.
- `notice`: un `warning` o `error` para el lector: `text` y un `code`, como `input_refused`.
- `command_output`: la salida de un comando slash que nunca llegó al modelo: `command` y `text`.
- `mission_updated`: cambió el registro de tareas de la sesión; vuelva a leerlo.
- `samples_updated`: cambiaron las muestras de la sesión; vuelva a leerlas.

Con `--partial` y `--format rows` se añaden las filas `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` y `retracted`. Los deltas pertenecen a `message_id` y `block`; una fila `retracted` retira los deltas de ese mensaje. La fila definitiva de texto o de herramienta es el valor completo.

El resultado incluye `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` y `denials`, con `answer` al completarse y `error` (`message`, `class`, `detail` opcional) si falla. `stop`, `api_ms`, `cost_usd`, la salida `structured` solicitada y `notices` se incluyen cuando están disponibles. `wall_ms` es el tiempo transcurrido del turno. `api_ms` es la suma de las duraciones de cada solicitud al modelo que hizo el turno (incluidos los reintentos y las solicitudes de los crewmates que se ejecutaron junto al hilo principal), por lo que puede superar a `wall_ms` cuando las solicitudes se solaparon. `cost_usd` es el importe en USD de las solicitudes con precio del turno, sea cual sea su estado: una solicitud que Mercury no puede valorar (sin tarifa registrada, sin coste indicado en la respuesta) no suma nada y deja su modelo listado en `models` sin un `cost_usd` propio; el campo solo está ausente cuando nada del turno tenía precio. Con un inicio de sesión por suscripción de Claude, las solicitudes de Anthropic no tienen precio en dólares, así que ni ellas ni la fila llevan `cost_usd`; el uso se conserva. El resumen de uso incluye `input_tokens` (con los tokens en caché incluidos), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` y, cuando se informa, `reasoning_output_tokens`, sumados en el hilo principal y en los crewmates. `models` desglosa el uso de tokens por modelo. `steps` cuenta solo las llamadas al modelo del agente principal; las llamadas al modelo hechas por los crewmates aparecen como sus propias filas `step`, etiquetadas con `parent_call_id`.

El estado es `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` o `loop_stopped`. Una ejecución con `--max-time` (en segundos, o `10m`, `1h`) termina con `time_limit` en el siguiente paso una vez agotado el tiempo; la llamada al modelo o la ronda de herramientas en curso no se corta. Una ejecución completada sale con código 0, los demás resultados con código 1, y un error de uso con código 2. SIGINT y SIGTERM salen con 130 y 143 después de que se escriba el resultado del turno interrumpido. Una llamada de herramienta rechazada aparece en `denials`. Cuando el rechazo fue una pregunta que nadie pudo responder (una ejecución sin host en un modo que pregunta, `--mode dontAsk` o una pregunta de un host que caducó) y ninguna llamada posterior de herramienta del turno tiene éxito, la ejecución queda como `blocked`: la respuesta se conserva, `error` indica la herramienta y cómo reanudar (`--allowed-tools`, otro `--mode` o un host que responda a las preguntas), y la ejecución sale con código 1. Si una llamada posterior de herramienta en el mismo turno tiene éxito, el turno se recupera y termina como `completed` (código 0) con un `notice` de advertencia (`"<Tool> was not approved; the run continued with other tools."`). Un rechazo que usted sí respondió (mediante una regla de denegación, un hook o un host que dijo que no) deja completado un turno completado. Una llamada `AskUserQuestion` sin respuesta también termina la ejecución como `blocked`, con la pregunta citada en `error`; Mercury lee el resultado de las preguntas registradas de la ejecución, nunca del texto de la respuesta, así que una pregunta escrita solo en la respuesta termina como `completed`. Un comando slash desconocido termina como `refused` con la misma frase que muestra la pantalla interactiva (`Unknown command: /name · /help lists commands`) y sale con código 1.

`--input rows` requiere `--format rows` y lee un objeto de entrada por línea:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Los tipos de entrada son `prompt` con `content` (bloques de texto o de texto e imagen), `shell` con `command` y `note` con `to` (un id de agente) y `content`. Cada uno acepta un `id` opcional; las filas de prompt y de shell aceptan además `priority` (`now`, `next` o `later`), `sent_at` y `origin`. Una forma de entrada rechazada produce un `notice` con el código `input_refused`; un JSON mal formado termina la ejecución. Estas filas solo llevan entrada; las respuestas de permisos usan el protocolo del runner descrito más abajo.

Use `mercury run -` o envíe texto por una tubería a `mercury run` para leer todo el prompt desde stdin. Junto a un argumento de prompt, el texto enviado por la tubería se añade como contexto delimitado: la tubería se lee hasta que se cierra o hasta que lleva un segundo sin datos, así que un flujo que sigue entregando datos se lee hasta el final, y una tubería que se queda abierta y sin datos no bloquea la ejecución. Sin prompt y con un terminal en stdin, `run` muestra su uso y sale con código 2.

`--mode <mode>` elige la postura de permisos. `--sovereign` se ejecuta sin solicitudes de permiso, y `--allow-sovereign` deja esa postura disponible para un cambio posterior. La política de permisos y las reglas de denegación siguen aplicándose. Un usuario root que entra en el modo sovereign recibe un aviso en stderr; la ejecución continúa.

Use `-c` para continuar la conversación más reciente, `-r` para reanudar por ID, título o selector, `-w` para ejecutar en un worktree gestionado, y `--lean` para una sesión mínima. Un `run` no tiene host que responda a las preguntas de permiso: sus reglas de permisos y su modo deciden qué puede ejecutarse, y una llamada que aún necesite aprobación se deniega.

### La imagen headless

El `Dockerfile` de la raíz del repositorio compila una imagen de Linux x64 para CI y servidores. Su punto de entrada es `mercury` y su verbo predeterminado es `run`, de modo que la imagen ejecuta un prompt contra un árbol montado y sale con el código de la ejecución:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

La imagen incluye el paquete, su entorno de ejecución de Node 24 (en `PATH`), las herramientas incluidas de búsqueda, shell, depurador, lenguajes e imágenes, `git` y el almacén de certificados; no tiene pantalla de entrada ni flujo de inicio de sesión. Se ejecuta como el usuario no root `mercury`, con su directorio de configuración dentro del contenedor (`MERCURY_CONFIG_DIR`), y `/work` es su directorio de trabajo. El color y el ratón siguen la detección de terminal propia del producto, y `--user 0` se ejecuta como root con el único aviso de sovereign descrito arriba.

Una clave de proveedor llega como variable de entorno, con los mismos nombres que el producto lee en todas partes: `ANTHROPIC_API_KEY` o `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` o `GOOGLE_API_KEY`, `XAI_API_KEY` (y `XAI_MANAGEMENT_API_KEY` para su medidor de uso), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (y `MISTRAL_ADMIN_API_KEY` para su medidor de organización), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` o `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` o `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` o `META_API_KEY`, `MERCURY_COMPAT_API_KEY` para un endpoint personalizado compatible con OpenAI y `MERCURY_LOCAL_API_KEY` para un servidor local. Sin clave, la ejecución se rechaza en una línea y sale con código 1. `docker run -i … mercury run -` lee el prompt desde stdin.

### Alojar una sesión

`mercury runner` sirve una sesión a un host a través de stdio: JSON-RPC 2.0, un mensaje por línea. El host envía `initialize` primero y espera la respuesta antes de enviar trabajo:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

El nombre y la versión del host viajan en `host`; `capabilities` declara `holds_asks`, `elicitation` y `partial_rows`. Cada `id` de solicitud es un entero positivo: una solicitud cuyo `id` sea cualquier otra cosa recibe la respuesta `-32600` con `id: null`, así que numere las solicitudes desde 1.

`queue/add` acepta el mismo objeto de prompt, shell o note que la entrada de filas descrita arriba. La salida llega en notificaciones `row`. `session/facts` lee el estado de la sesión; `session/set_mode` cambia el modo de permisos de inmediato; `session/set_model` y `session/set_effort` cambian el modelo y el esfuerzo, y un cambio hecho mientras se ejecuta un turno se retiene hasta que el turno termina: responde con `at: "turn_end"` y después `session/applied` lo anuncia. `turn/interrupt` detiene un turno; cierre stdin para terminar la sesión.

Las preguntas de permiso llegan como `permission/request`, con `kind: "tool"` o `kind: "network"`. El host responde con `outcome: "allow"` u `outcome: "deny"`; un allow puede llevar un `input` editado y `rules` de permiso. Una pregunta retirada envía `$/cancel_request` con su `request_id`. `holds_asks` da al host la titularidad del temporizador de la pregunta. Una pregunta de MCP usa `elicitation/request` solo cuando el host declara `elicitation`; en caso contrario recibe la respuesta `cancel`.

Un método desconocido recibe `-32601`, los parámetros no válidos `-32602`, un `id` que no es entero positivo `-32600`, y una solicitud anterior a la inicialización `-32002`. Un rechazo por regla es `-32010`, con una frase en `error.message` y un motivo en `error.data.kind`, como `mode`, `model`, `effort` o `claim`. El runner responde a una línea mal formada con `-32700` y continúa; tres líneas mal formadas consecutivas lo terminan.

### Otros comandos

Entre los comandos disponibles se incluyen:

- **`mercury health`**: informe de diagnóstico, también llamado certificado de salud. `--json` devuelve el informe completo, `--deep` ejecuta el inventario profundo y `--fix` ejecuta las correcciones guiadas.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: inicia sesión (`login [<family>]`), lista las familias de proveedores (`list`), comprueba si una cuenta tiene sesión iniciada (`status [<family>]`), cierra sesión (`logout [<family>]`) o genera un token de Anthropic de larga duración (`mint`).
- **`mercury models [--json]`**: muestra los modelos a los que llegan las cuentas con sesión iniciada (los mismos datos que `mercury://models`).
- **`mercury mcp`**: gestiona los servidores MCP con `add`, `import`, `list`, `get`, `remove`, `trust-reset` y `serve`.
- **`mercury extensions`**: instala extensiones y gestiona sus orígenes. Acciones: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` y `scaffold`.
- **`mercury roster`**: lista el inventario de agentes.
- **`mercury usage`**: muestra la línea compacta de cifras que muestra la pantalla `/usage`; `--json` muestra la lectura completa: las ventanas de cada proveedor con sesión iniciada con lo usado y el reinicio, las cifras y los créditos que declaró, cada uno con su origen y su antigüedad, y el gasto de la sesión por modelo, leído tal como lo lee la pantalla (el lector de cada proveedor con sesión iniciada se muestrea una vez, como al abrirla).
- **`mercury daemon run|status|stop|restart`**: ejecuta, inspecciona, detiene o reinicia el daemon en segundo plano. Sus puestos de sesión son procesos hijo de `mercury runner`; el daemon envía sus prompts y aloja sus preguntas de permiso.
- **`mercury sessions list`** (también `mercury sessions` sin más): lista las sesiones guardadas de este proyecto, de la más reciente a la más antigua: el id, cuándo se escribió por última vez, su tamaño, `live` cuando el daemon la aloja en este momento, y su título o su primer prompt; `--all` lee todos los proyectos y `--limit <n>` limita la lista. El id es lo que reabre `mercury --resume <id>` y lo que elimina `sessions delete`.
- **`mercury sessions delete <id>`**: elimina a propósito una sesión guardada (su transcripción y los registros que se guardan junto a ella: recibos e instantánea de reanudación), tras una pregunta; `--yes` omite la pregunta en los scripts. Una sesión que el daemon aloja en ese momento se rechaza, y un id desconocido se rechaza con una indicación para consultar el inventario (`/sessions` dentro de Mercury). Las sesiones guardadas nunca se eliminan por sí solas.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: ejecuta un equipo local o SSH como servidor de modelos para todas las sesiones que comparten el directorio de configuración (`compat/box-<name>/<model>`), usando un banco local de pesos verificado o una descarga confirmada. Consulte [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** y **`mercury lsp install <server>`**: el catálogo de servidores de lenguaje, con cada servidor instalado (con su binario) o ausente (con su instrucción de instalación); `install` muestra la instrucción de instalación de un servidor, pregunta, ejecuta exactamente esa instrucción (`--yes` omite la pregunta en los scripts) e informa de dónde quedó el binario. Un servidor desconocido se rechaza con el inventario. Mercury nunca instala un servidor de lenguaje por su cuenta; abrir un archivo solo inicia un servidor que ya esté instalado.
- **`mercury acp`**: sirve un editor a través del Agent Client Protocol, con un proceso runner hijo por cada sesión. `mercury bridge install` instala la extensión de VS Code; `mercury bridge status` la comprueba; `mercury bridge uninstall` la elimina.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: gestiona trabajos del motor para el proyecto de Godot del directorio actual. Mercury ejecuta las suites en sus propios workers headless a partir de una copia congelada del proyecto. El servicio incluye una puerta de compilación, capturas, estadísticas de fotogramas, perfiles definitivos, acceso a la cola de trabajos, cancelación y resultados por ID. Consulte [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: muestra una imagen en la terminal.
- **`mercury install`** y **`mercury update`** (alias `upgrade`): instalan o actualizan los archivos de versión; con `--json` el documento va a stdout sea cual sea el veredicto, y el código de salida indica si falló. Consulte [Instalación](#instalación).
- **`mercury version`** y **`mercury help [command]`**: muestran la línea de versión o una página de ayuda, lo mismo que `--version` y `--help`; ninguno de los dos inicia una sesión.

## Qué incluye: memoria RAG de Mneme, LSP, AST de 23 lenguajes, depurador DAP, búsqueda web e integraciones

- **Memoria de proyecto RAG híbrida Mneme.** Mneme está activado de forma predeterminada y guarda los hechos de cada proyecto en páginas temáticas de markdown en texto plano (`Retain`, `Recall`, `Reflect`, `Correct`). Recall combina un modelo de embeddings semánticos BGE de 118 MB que se ejecuta en el propio dispositivo (`bge-base-en-v1.5` `q8_0`, MIT, incluido en cada archivo de versión y compilado para su plataforma; consulte [Componentes opcionales](#componentes-opcionales)) con el ranking de palabras BM25 con stemming, la ponderación por recencia y el seguimiento de citas mediante fusión por rango recíproco (`k = 60`). Las reglas fijadas (`pin: true`) se cargan textualmente en la sección de reglas fijadas y solo cambian cuando usted lo indica. Al iniciar la sesión, Mercury puntúa los hechos no fijados y las notas anteriores según su rama actual, los archivos tocados recientemente y la nota de traspaso de la última sesión, dentro de un margen de inicio propio (`memory.startLimit`, 4.000 caracteres por defecto). Las comprobaciones de contradicciones al guardar detectan cambios de polaridad, negación y números antes de que se guarde un hecho en conflicto. Cada sesión escribe al salir una nota de traspaso con sus propias palabras para la página de entrada de la siguiente sesión, además de una entrada opcional en el diario de la sesión. `/memory` abre el centro de memoria, y `/memory page` dibuja la biblioteca en su navegador como un grafo de nodos y aristas. Consulte [docs/MNEME.md](../MNEME.md).
- **Inteligencia de código LSP, reescrituras AST de 23 lenguajes, depurador DAP y celdas `Eval`.** Lecturas con ancla y ediciones atómicas de varios archivos (`ChangeSet`); consultas al servidor de lenguaje (`LspRead`) y refactorizaciones de vista previa y aplicación posterior (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); búsqueda y reescritura sobre el árbol sintáctico (`AstSearch`, `AstEdit`) con las metavariables `$NAME` y `$$$NAME` en 23 gramáticas incluidas en los archivos de versión (16 en cada compilación con `bun install` y 7 en el paquete de gramáticas); celdas de código persistentes de Python (`python3`) y JavaScript (módulo ES de Node) (`Eval`); y un depurador de Debug Adapter Protocol (`Debug`) que maneja `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, el adaptador de depuración del SDK de Dart, `kotlin-debug-adapter`, el adaptador de depuración de elixir-ls y Godot. La herramienta `Test`, mediante su operación `debug`, abre una prueba fallida de Python (`pytest`, `unittest`), JavaScript/TypeScript (`node-test`, `vitest`, `jest`), Go (`go test`) o Rust (`cargo test`) directamente en una sesión de `Debug`, en la que se puede avanzar paso a paso. Consulte [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [transacciones de cambios](../CHANGE-TRANSACTIONS.md), [patrones estructurales](../STRUCTURAL-PATTERNS.md), [celdas de código](../EVAL.md) y [el depurador](../DEBUGGER.md).
- **`WebSearch` sin clave y `WebFetch` en markdown.** `WebSearch` recorre una única cascada: primero la búsqueda en vivo nativa del proveedor cuando el modelo de la sesión la admite (`ProviderSearch`), después las claves guardadas de Brave o Tavily, después las APIs oficiales elegidas según la forma de la consulta (Stack Exchange, npm, PyPI, crates.io, búsqueda de código de GitHub, Hacker News Algolia, Wikipedia), después las APIs JSON de SearXNG configuradas (`MERCURY_SEARCH_SEARXNG_INSTANCES`) y, por último, el scraping de páginas de DuckDuckGo sin clave (activado por defecto; desactívelo en `/config` o con `MERCURY_SEARCH_KEYLESS=0`). Cada respuesta se mantiene por debajo de 2.000 tokens y nombra la fuente que respondió. `WebFetch` lee páginas públicas en markdown con las palabras propias de la página dentro de un presupuesto de 38.000 caracteres por llamada (una página que necesita un navegador se lee a través del lector alojado `r.jina.ai`, salvo que se defina `MERCURY_FETCH_READER=0`, y una dirección de red privada nunca se envía a él). Consulte [docs/ENGINES.md](../ENGINES.md).
- **Agentes, crewmates entre proveedores (`Crewmate`), worktrees y reservas de archivos.** Dos agentes integrados (`mercury-crew` para el trabajo delegado de cualquier tipo y `mercury-scout` para el reconocimiento de solo lectura) se suman a las definiciones de agente que usted crea en `/agents`. Lance crewmates con cualquier proveedor con sesión iniciada, aísle el trabajo en paralelo en copias de `git worktree` (`isolation: "worktree"`), coordine los archivos compartidos con reservas de archivos del proyecto dentro del propio proceso (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), y dirija o reanude crewmates por nombre o id con `SendMessage` y `ResumeCrewmate`. Siga a los crewmates y las ejecuciones de workflow en `/crewmates` y `/runs`. Consulte [docs/CREW.md](../CREW.md).
- **Control del escritorio.** Está activado por defecto cuando el controlador nativo de escritorio está disponible. La herramienta `Computer` toma capturas de pantalla y controla el ratón y el teclado en la aplicación en primer plano. Mercury comprueba la aplicación por su nombre y su identidad antes de actuar, pide aprobación salvo que sus reglas de permisos, la concesión de la sesión, el ajuste de acceso o el modo de permisos ya permitan la acción, se detiene con `Esc`, deja que solo una sesión controle el escritorio a la vez y mantiene las capturas fuera del archivo de conversación guardado. Defina `MERCURY_COMPUTER_USE=0` para quitar la herramienta. Consulte [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Entrada de voz con Whisper en el propio dispositivo (`/voice`).** `/voice on` descarga en el primer uso el modelo de voz en inglés de 60 MB (`base.en-q5_1`), verifica su digest SHA-256 y activa el dictado; `/voice off` lo desactiva. Mantenga pulsada la barra espaciadora durante 1 s para hablar y suéltela para detener, o ejecute `/voice` sin más para iniciar y detener una toma mientras la voz está activa. Whisper transcribe en el propio dispositivo, de modo que el audio de voz nunca sale del equipo, y `MERCURY_WHISPER_MODEL` elige `tiny.en-q5_1`, `small.en-q5_1`, el modelo multilingüe `base-q5_1` o un archivo `.gguf` local. Consulte [docs/VOICE.md](../VOICE.md).
- **Programador cron y de sesiones Saturn (`/saturn`).** Programe un prompt para una sesión existente (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) o programe una sesión nueva para que empiece a una hora fijada. Los programas pueden ejecutarse una sola vez o repetirse. Consulte [docs/SATURN.md](../SATURN.md).
- **Integraciones con VS Code (ACP), Unity, Blender, Godot y Aseprite.** `mercury acp` se conecta con los editores que admiten el Agent Client Protocol. La extensión de VS Code (`mercury bridge install`) ejecuta Mercury dentro del editor a través de ese protocolo: chat, sesiones, agentes, artefactos y revisiones, con la selección y los diagnósticos del editor acompañando a cada prompt. Hay integraciones independientes y opcionales que se conectan a los editores Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) y Godot (`MERCURY_GODOT_TOOLS=1`) cuando están en ejecución, y acceso por lotes a Aseprite (`MERCURY_ASEPRITE=1`). Consulte [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) y [Aseprite](../ASEPRITE-BRIDGE.md).
- **Extensiones.** Cada extensión tiene un único manifiesto. Añada orígenes desde una URL de git, una carpeta local o un archivo, aprobados mediante su hash de contribuciones. Consulte [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Configuración por repositorio de lo que cargan las sesiones, con preajustes con nombre y controles que puede cambiar durante una sesión. Consulte [docs/KIT.md](../KIT.md).
- **Diagnósticos.** La comprobación de estado y `/health` producen un informe respaldado por evidencia de diagnóstico, con un veredicto `certified`, `caution` o `fault` y correcciones verificadas. Consulte [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Confianza y permisos.** La confianza en el espacio de trabajo, las reglas y los modos de permisos, y los comandos que todas las sesiones rechazan. Consulte [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, la entrevista de especificación: responda a las preguntas del agente para completar la especificación que usará para construir un prototipo. Consulte [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Recuperación.** Publicación atómica, operaciones con diario y reconciliación al inicio. Consulte [docs/DURABILITY.md](../DURABILITY.md).

Los indicadores de ejecución se definen en `src/substrate/flagRegistry.ts`, se exponen como ajustes `MERCURY_*` y se generan bajo demanda. La compatibilidad con integraciones se documenta en [docs/COMPATIBILITY.md](../COMPATIBILITY.md). El índice completo de la documentación está en [docs/README.md](../README.md).

## Comandos slash

`/help` lista los comandos interactivos disponibles. Use `/palette` para la búsqueda aproximada de comandos. La tabla siguiente agrupa los comandos integrados activados por defecto según las categorías que usa `/help`; la lista en vivo incluye además `/samples` en `current work` cuando Samples está activado (`MERCURY_SAMPLES=1` o la fila Samples del Boot Menu), `/showcase` cuando se define `MERCURY_DEV_SURFACES=1`, y cualquier skill o comando de extensión.

| Categoría | Comandos |
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

| Comando | Qué hace |
| --- | --- |
| `/llmhost` | Elija un modelo para alquilar en Runpod, Vast.ai o Lambda, ejecutarlo en su propio equipo o conectar un servidor existente. |
| `/restart` | Traslada este chat a la compilación de Mercury instalada; los monitores en ejecución y los shells en segundo plano se detienen. |
| `/mcp` | Inspeccione los servidores, inicie sesión, explore las herramientas y los parámetros de cada servidor, reconecte o active y desactive un servidor para este chat. |

`/mouse off` devuelve el puntero a la terminal para seleccionar y copiar texto de forma nativa. La preferencia se guarda y aparece en `/config` como Mouse capture.

Un argumento obligatorio se indica con `<…>` en el uso de un skill. Por ejemplo, `/update-config` y `/debug` necesitan un argumento. Si envía uno solo, obtiene su descripción y su uso; no se inicia ningún turno. Si lo selecciona en el autocompletado y pulsa Enter, queda `/name ` listo para que añada el argumento. `/loop` no tiene argumento obligatorio y se ejecuta de inmediato.

## Informar de un problema

Para un informe breve, use [el formulario para probadores](https://mercury-cli.ai/report) o `/bug --short <what you tried>` dentro de Mercury. Le pide su sistema operativo, lo que probó y lo que falló; no hace falta un volcado de la comprobación de estado.

Ejecute `/bug <what happened>` dentro de Mercury para ver una vista previa del informe antes de enviarlo con la GitHub CLI (`gh`), con la sesión iniciada. Sin `gh`, Mercury guarda un borrador local en el directorio de configuración y le indica la página de issues del repositorio.

También puede abrir un issue directamente con la plantilla de error (bug), de proveedor/modelo o de solicitud de funcionalidad. Incluya la salida de `--version`, su sistema operativo, su terminal y los pasos exactos. Los informes de error y de proveedor también necesitan `mercury health --json`, o `node dist/mercury.mjs health --json` en una compilación desde el código fuente. Ayuda una transcripción de la pantalla que falla.

Informe de los problemas de seguridad en privado a través de la pestaña Security del repositorio. No los incluya en issues públicos. Consulte [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) trata los issues, las pull requests y las comprobaciones.

## Licencia

Mercury CLI se rige por la Apache License 2.0 (`Apache-2.0`) recogida en [LICENSE.md](../../LICENSE.md). Los SDK de TypeScript y de Python, en [sdk/](../../sdk/) y [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` en npm y PyPI), también se rigen por la Apache License 2.0 (`Apache-2.0`), cada uno según el archivo LICENSE que incluye ([sdk/LICENSE](../../sdk/LICENSE) y [sdk-py/LICENSE](../../sdk-py/LICENSE)).

El uso del nombre y de las marcas de Mercury se rige por la [política de marcas](../../TRADEMARKS.md). Las licencias de terceros incluidas se enumeran en [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
