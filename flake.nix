{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    npmlock2nix-repo = {
      url = "github:nix-community/npmlock2nix";
      flake = false;
    };
  };

  outputs = { nixpkgs, flake-utils, npmlock2nix-repo, ... }:
    flake-utils.lib.eachDefaultSystem (system: let
        pkgs = import nixpkgs { inherit system; };
        npmlock2nix = import npmlock2nix-repo { inherit pkgs; };
      in rec {
        packages.nix-flake-tools = let
          vsix = npmlock2nix.build {
            nodejs = pkgs.nodejs-14_x;
            src = ./.;

            node_modules_attrs = {
              nativeBuildInputs = [ pkgs.python3 pkgs.pkg-config pkgs.libsecret ];
            };

            buildCommands = [ "env" "npx vsce package -o $name.zip" ];
            installPhase = ''
              mkdir $out
              cp $name.zip $out/
            '';
          };
        in
          pkgs.vscode-utils.buildVscodeExtension {
            name = vsix.name;
            src = "${vsix}/${vsix.name}.zip";
            vscodeExtUniqueId = "rastertail.nix-flake-tools";
          };
        defaultPackage = packages.nix-flake-tools;

        devShell = pkgs.mkShell {
          buildInputs = [ pkgs.nodejs-14_x ];
        };
      }
    );
}
