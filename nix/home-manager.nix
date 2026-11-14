packages: { config, lib, pkgs, ... }:
let cfg = config.programs.mercury;
in {
  options.programs.mercury = {
    enable = lib.mkEnableOption "Mercury";
    package = lib.mkOption {
      type = lib.types.package;
      default = packages.${pkgs.stdenv.hostPlatform.system}.mercury;
      description = "The Mercury package to install.";
    };
  };
  config = lib.mkIf cfg.enable { home.packages = [ cfg.package ]; };
}
