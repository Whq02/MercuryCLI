# Mercury with Nix

The flake installs the same signed Mercury release archives as the website installer, including Node, Python, ripgrep, the shell engine, structural grammars and their licences. Nix owns the installed files; configuration and sessions stay in your normal writable Mercury home.

## Run or install

```sh
nix run github:Whq02/MercuryCLI
nix profile add github:Whq02/MercuryCLI
mercury --version
```

On Nix before 2.30, use `nix profile install` instead of `nix profile add`. Enable Nix's `nix-command` and `flakes` experimental features if your Nix installation has not already enabled them.

Follow the repository's default branch, as these examples do: release pins are refreshed after the release archives are published, so a release tag's flake still names the previous release. A lock file in a consuming flake fixes the Mercury revision and therefore its archive hashes.

The initial 1.0.10 pin predates Nix ownership and has no switch that disables managed installation writes: use the Nix command explicitly and manage that release through Nix rather than its `mercury install` or `mercury update` commands.

The four package systems are `x86_64-linux`, `aarch64-linux`, `x86_64-darwin` and `aarch64-darwin`. Intel macOS uses `nixpkgs-26.05-darwin`, the last Nixpkgs release line that supports it. Each has `packages.<system>.mercury` and `.default`, and matching `apps` outputs. No release API is contacted during flake evaluation.

## Updates and removal

Update the flake input in the configuration that installs Mercury, then apply that configuration. For a profile installation, `nix profile list` shows the entry's name; use `nix profile upgrade <name>` to update it, or `nix profile remove <name>` to remove it. Rollback belongs to the profile's or configuration's generations.

From a release containing Nix ownership support, `mercury update` and `mercury update --check` answer `this Mercury was installed by Nix; update the flake input or the profile that provides it`. They run no package-manager command, ask nothing and download nothing. `--status` reports Nix ownership; `--rollback` gives the existing package-manager guidance instead of changing Mercury's managed versions. `mercury install`, including `--uninstall`, leaves the Nix package and any co-resident managed installation alone. Startup does not create a managed launcher ahead of the profile's command.

## Flake integrations

In an existing NixOS flake that already has a `nixpkgs` input:

```nix
{
  inputs.mercury.url = "github:Whq02/MercuryCLI";

  outputs = { self, nixpkgs, mercury, ... }: {
    nixosConfigurations.workstation = nixpkgs.lib.nixosSystem {
      modules = [
        mercury.nixosModules.default
        { programs.mercury.enable = true; }
      ];
    };
  };
}
```

For Home Manager, add `mercury.homeManagerModules.default` to its modules and set the same `programs.mercury.enable` option. Both modules only install a package; `programs.mercury.package` can override it. They do not create settings, copy credentials or rewrite a Mercury home.

Alternatively, add `mercury.overlays.default` to your package set's overlays and use `pkgs.mercury`. The overlay refers to the flake's release package for that host system.

## Linux execution

On a regular Linux distribution, the wrapper first starts the archive's own Node runtime; if it works, Mercury runs directly without a namespace. Where the host cannot start that runtime, as on an ordinary NixOS installation, it uses a package-owned FHS environment for Node and its bundled children. Neither road patches the signed payload, and neither changes the working directory or replaces the archive's bundled tools with Nix versions. Nix supplies git when the caller's PATH does not already supply it.

The FHS road needs user namespaces and does not support setuid commands such as `sudo` inside Mercury's shell; run those commands in a terminal outside that environment.

When Mercury was invoked through a profile that links `libexec/mercury` beside `bin`, its daemon record and suggested shell command retain the profile path, so an upgrade does not leave them naming an old store output. A `nix profile` installation links it, and the NixOS module adds `/libexec/mercury` to `environment.pathsToLink` for the system profile; a profile that links `bin` alone is given the package's store path instead.

## Development shell

`nix develop` supplies a locked development environment with Bun, Node, Rust, C/C++ build tools, Python, git and ripgrep. It runs no setup hook. The project's normal prerequisites and `bun run setup` / `bun run build.ts` still apply; this is not a reproducible Nix source build of Mercury or a source-built replacement for its signed release package.

A reproducible source derivation would additionally need fixed-output JavaScript dependencies and patches, every vendor lock and platform pack, Cargo inputs for the native addons, the model artifacts and their licences, and the project's full build and packaging checks. It would be labelled as a source build, not signed with the release private key.

## Release pins

After the four POSIX archives have been finalized, signed, checksummed and published, run:

```sh
node scripts/release/refresh-nix-release-pins.mjs --version 1.0.11 --archives release-out
```

The script reads that directory's `SHA256SUMS.txt`, verifies each archive's hash and deep signed version/target, checks the complete declared payload, and atomically writes `nix/release.json`. A missing archive, unsigned name, incomplete record or mismatched identity leaves the previous pins untouched. `--check` performs the same verification and compares the pins without writing them; `--sums` and `--out` select other input/output paths.

The pin update rides the existing post-release documentation commit, after the asset URLs exist. It never rebuilds an archive, changes signed bytes or pushes a commit. Do not edit the four hashes by hand.

For a local release qualification, the package's override accepts `archive = /absolute/path/to/the-signed-archive.tar.gz` and `version = "1.0.11"`; the override changes no committed pin and still requires deep signature verification for the system being built. `nix flake check` evaluates the integrations and builds the package checks for the current system.
