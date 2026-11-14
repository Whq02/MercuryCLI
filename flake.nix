{
  description = "Mercury's signed releases for Nix";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  outputs = { self, nixpkgs, nixpkgs-darwin }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      eachSystem = f: builtins.listToAttrs (map (system: { name = system; value = f system; }) systems);
      pkgsFor = system: import (if system == "x86_64-darwin" then nixpkgs-darwin else nixpkgs) { inherit system; };
      release = builtins.fromJSON (builtins.readFile ./nix/release.json);
    in {
      packages = eachSystem (system:
        let mercury = (pkgsFor system).callPackage ./nix/package.nix { inherit release system; };
        in { inherit mercury; default = mercury; });
      apps = eachSystem (system:
        let mercury = { type = "app"; program = "${self.packages.${system}.mercury}/bin/mercury"; inherit (self.packages.${system}.mercury) meta; };
        in { inherit mercury; default = mercury; });
      overlays.default = final: prev: { mercury = self.packages.${final.stdenv.hostPlatform.system}.mercury; };
      homeManagerModules = rec { mercury = import ./nix/home-manager.nix self.packages; default = mercury; };
      nixosModules = rec { mercury = import ./nix/nixos-module.nix self.packages; default = mercury; };
      devShells = eachSystem (system:
        let pkgs = pkgsFor system;
        in { default = pkgs.mkShell { packages = with pkgs; [ bun nodejs_24 cargo rustc clang cmake pkg-config python3 git ripgrep curl ]; }; });
      checks = eachSystem (system:
        let pkgs = pkgsFor system; mercury = self.packages.${system}.mercury;
        in {
          package = mercury;
          modules = import ./nix/check-modules.nix { inherit pkgs mercury; inherit (self) homeManagerModules nixosModules; };
        });
    };
}
