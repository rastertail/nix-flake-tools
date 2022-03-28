**WARNING: This extension uses very very very dirty hacks to modify the environment of the root VS Code process! Use at your own risk!**

# Nix Flake Tools for VS Code

An extension providing development tools for projects based on Nix Flakes.
Currently, it only offers a command to enter a flake-based development shell, but more is planned for the future.

## Prerequisites

* Linux or macOS
* [Nix](https://nixos.org/) with `flakes` and `nix-command` enabled

## Installation

Either:

* Build the VSIX with `nix build github:rastertail/nix-flake-tools#vsix`, then install with `code --install-extension ./result/nix-flake-tools-[version].zip`
* Include the flake and reference `nix-flake-tools.packages."[your system]".extension` in your configuration for VS Code extensions, either through `vscode-with-extensions` or Home Manager. 

## Contributing

Feel free to open pull requests!
There are plenty of TODOs scattered around the code in case you don't know where to start...

## Legal

Nix Flakes Tools is licensed under the GNU General Public License Version 3. See the LICENSE file for details.
