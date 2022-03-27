import commandExists from "command-exists";
import * as vscode from "vscode";

import { loadEnvironment } from "./load";

export async function activate(ctx: vscode.ExtensionContext) {
    // Get configured Nix command
    const nixCommand = vscode.workspace.getConfiguration("nixFlakeTools")
        .get("nixCommand", "nix");

    // Check if the configured Nix command exists and update context
    const nixFound = await commandExists(nixCommand)
        .then(_cmd => true)
        .catch(() => false);
    vscode.commands.executeCommand(
        "setContext",
        "nixFlakeTools.nixFound",
        nixFound
    );

    // TODO Make sure Nix has flake support enabled

    // Alert the user if Nix is not found and exit
    if (!nixFound) {
        vscode.window.showErrorMessage("Nix command not found. Flake integrations will be disabled.");
        return;
    }

    // Create status bar item, potentially setting content
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    if (process.env["VSCODE_IN_FLAKE_ENV"] != undefined) {
        statusBarItem.text = "$(nix-snowflake) Nix environment active";
        statusBarItem.show();
    } else if (process.env["IN_NIX_SHELL"] != undefined) {
        statusBarItem.text = "$(nix-snowflake) Nix environment active (external)";
        statusBarItem.show();
    }

    // Register commands
    ctx.subscriptions.push(vscode.commands.registerCommand("nixFlakeTools.loadDevEnv", async () => {
        await loadEnvironment(statusBarItem);
    }));
}