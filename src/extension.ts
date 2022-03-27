import commandExists from "command-exists";
import * as vscode from "vscode";

import { restoreEnvironment } from "./environment";
import { loadEnvironment } from "./load";
import { promptReload } from "./util";

export async function activate(ctx: vscode.ExtensionContext) {
    // Get configured Nix command
    const config = vscode.workspace.getConfiguration("nixFlakeTools");
    const nixCommand = config.get("nixCommand", "nix");

    // Check if the configured Nix command exists and update context
    const nixFound = await commandExists(nixCommand)
        .then((_cmd) => true)
        .catch(() => false);
    vscode.commands.executeCommand(
        "setContext",
        "nixFlakeTools.nixFound",
        nixFound
    );

    // TODO Make sure Nix has flake support enabled

    // Alert the user if Nix is not found and exit
    if (!nixFound) {
        vscode.window.showErrorMessage(
            "Nix command not found. Flake integrations will be disabled."
        );
        return;
    }

    // Create status bar item, potentially setting content
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left
    );

    const inFlakeEnv = process.env["VSCODE_IN_FLAKE_ENV"];
    if (inFlakeEnv != undefined) {
        statusBarItem.text = "$(nix-snowflake) Nix environment active";
        statusBarItem.show();
    } else if (process.env["IN_NIX_SHELL"] != undefined) {
        statusBarItem.text =
            "$(nix-snowflake) Nix environment active (external)";
        statusBarItem.show();
    }

    // Set context if we are in a managed flake environment
    vscode.commands.executeCommand(
        "setContext",
        "nixFlakeTools.inManagedEnv",
        inFlakeEnv
    );

    // Register commands
    ctx.subscriptions.push(
        vscode.commands.registerCommand(
            "nixFlakeTools.loadDevEnv",
            async () => {
                await loadEnvironment(statusBarItem);
            }
        )
    );
    ctx.subscriptions.push(
        vscode.commands.registerCommand(
            "nixFlakeTools.restoreEnv",
            async () => {
                // Restore environment
                statusBarItem.text = "$(loading~spin) Restoring environment...";
                await restoreEnvironment();

                // Update context
                vscode.commands.executeCommand(
                    "setContext",
                    "nixFlakeTools.inManagedEnv",
                    false
                );

                // Prompt reload
                promptReload(statusBarItem);
            }
        )
    );

    // Ask the user if they want to enter the current flake environment
    if (inFlakeEnv == undefined && config.get("askToLoadFlakeEnv", true)) {
        const action = await vscode.window.showInformationMessage(
            "Enter the development environment for this workspace's Nix flake?",
            "Yes",
            "No",
            "Don't Ask Again"
        );

        if (action == "Yes") {
            vscode.commands.executeCommand("nixFlakeTools.loadDevEnv");
        } else if (action == "Don't Ask Again") {
            config.update("askToLoadFlakeEnv", false, true);
        }
    }
}
