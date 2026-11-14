{ lib, stdenvNoCC, fetchurl, runCommand, writeShellScript, writeShellScriptBin, buildFHSEnv, nodejs_24, git, release, system, archive ? null, version ? release.version }:
let
  pin = release.systems.${system};
  target = pin.target;
  source = if archive == null then fetchurl { inherit (pin) url; sha256 = pin.sha256; } else archive;
  payload = stdenvNoCC.mkDerivation {
    pname = "mercury-payload";
    inherit version;
    src = source;
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;
    unpackPhase = ''
      tar -tzf "$src" > members
      if grep -Ev '^mercury(/|$)' members; then exit 1; fi
      tar -xzf "$src"
      test -d mercury
    '';
    installPhase = ''
      mkdir -p "$out/libexec" "$out/nix-support"
      cp -a mercury "$out/libexec/mercury"
      printf 'libexec/mercury\n' > "$out/nix-support/mercury"
      ${nodejs_24}/bin/node ${./verify-release.mjs} "$out/libexec/mercury" ${lib.escapeShellArg version} ${lib.escapeShellArg target}
    '';
  };
  fhs = if stdenvNoCC.hostPlatform.isLinux then buildFHSEnv {
    name = "mercury-fhs";
    targetPkgs = pkgs: with pkgs; [
      git glibc stdenv.cc.cc.lib zlib openssl libxcrypt-legacy libffi
      bzip2 xz zstd ncurses readline sqlite util-linux
      alsa-lib libpulseaudio libGL glib nss nspr expat libxkbcommon
      libx11 libxtst libxrandr libxcursor libxi
    ];
    multiPkgs = pkgs: [];
    runScript = writeShellScript "mercury-in-fhs" ''exec "$@"'';
    unsharePid = false;
    dieWithParent = false;
  } else null;
  launcher = writeShellScriptBin "mercury" ''
    case "$0" in
      /*) invoked="$0" ;;
      */*) invoked="$PWD/$0" ;;
      *) invoked="$(command -v -- "$0")" ;;
    esac
    prefix="''${invoked%/bin/mercury}"
    entry="$prefix/libexec/mercury/mercury"
    if [ ! -f "$entry" ]; then entry=@out@/libexec/mercury/mercury; fi
    export PATH="''${PATH:+$PATH:}${lib.makeBinPath [ git ]}"
    ${lib.optionalString stdenvNoCC.hostPlatform.isLinux ''
      if ! "''${entry%/mercury}/vendor/node/bin/node" -e 'process.exit(0)' >/dev/null 2>&1; then
        exec ${fhs}/bin/mercury-fhs "$entry" "$@"
      fi
    ''}
    exec "$entry" "$@"
  '';
in runCommand "mercury-${version}" {
  inherit version;
  passthru = { inherit payload fhs; };
  meta = {
    description = "Mercury terminal development harness, from the signed release";
    homepage = "https://mercury-cli.ai";
    license = lib.licenses.asl20;
    mainProgram = "mercury";
    platforms = builtins.attrNames release.systems;
  };
} ''
  mkdir -p "$out/bin" "$out/libexec"
  substitute ${launcher}/bin/mercury "$out/bin/mercury" --subst-var out
  chmod +x "$out/bin/mercury"
  ln -s ${payload}/libexec/mercury "$out/libexec/mercury"
''
