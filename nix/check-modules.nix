{ pkgs, mercury, homeManagerModules, nixosModules }:
let
  evaluate = module: path: enable: extra: pkgs.lib.evalModules {
    specialArgs = { inherit pkgs; };
    modules = [ module {
      options = pkgs.lib.setAttrByPath path (pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.package; default = []; });
      config.programs.mercury.enable = enable;
    } ] ++ extra;
  };
  links = { options.environment.pathsToLink = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.str; default = []; }; };
  home = evaluate homeManagerModules.mercury [ "home" "packages" ] true [];
  system = evaluate nixosModules.mercury [ "environment" "systemPackages" ] true [ links ];
  disabled = evaluate homeManagerModules.mercury [ "home" "packages" ] false [];
in
assert home.config.programs.mercury.package == mercury;
assert system.config.programs.mercury.package == mercury;
assert builtins.elem mercury home.config.home.packages;
assert builtins.elem mercury system.config.environment.systemPackages;
assert builtins.elem "/libexec/mercury" system.config.environment.pathsToLink;
assert disabled.config.home.packages == [];
pkgs.runCommand "mercury-module-checks" {} ''touch "$out"''
