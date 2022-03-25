import * as child from "child_process";

import * as commandExists from "command-exists";
import * as cdp from "chrome-remote-interface";
import * as vscode from "vscode";

async function injectEnvironment(vars: Map<string, string>) {
    // Assume parent process is the root VSCode process
    const rootProc = process.ppid;

    // Start debug session on the root process
    (process as any)._debugProcess(rootProc);

    // Connect debugger
    const dbg = await cdp({ host: "127.0.0.1", port: 9229 });

    // Apply environment variables
    for (const [name, value] of vars) {
        // Escape quotes in variable values
        value.replace(/"/g, '\\"');

        await dbg.Runtime.evaluate({ expression: `process.env["${name}"] = "${value}";` });
    }

    // Close debugger
    await dbg.close();
}

export async function activate(ctx: vscode.ExtensionContext) {
    // Get extension configuration
    const config = vscode.workspace.getConfiguration("nixFlakeTools");

    // Read specific configuration options
    const nixCommand = config.get("nixCommand", "nix");
    const developInstallable = config.get<string>("devInstallable");
    const nixImpure = config.get("nixImpure", false);

    // Check if the configured Nix command exists and update context
    const nixFound = await commandExists(nixCommand)
        .then(_cmd => true)
        .catch(() => false);
    vscode.commands.executeCommand(
        "setContext",
        "nixFlakeTools.nixFound",
        nixFound
    );

    // Alert the user if Nix is not found and exit
    if (!nixFound) {
        vscode.window.showErrorMessage("Nix command not found. Flake integrations will be disabled.");
        return;
    }

    // TODO Make sure Nix has flake support enabled

    // Create status bar item, potentially setting content
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    if (process.env["IN_NIX_SHELL"] != undefined) {
        statusBarItem.text = "$(nix-snowflake) Nix environment active";
        statusBarItem.show();
    }

    // Get flake directory (at least one assumed to exist by activation events)
    const flakeFiles = (await vscode.workspace.findFiles("flake.nix", "")).map(uri => uri.fsPath);

    // Register commands
    ctx.subscriptions.push(vscode.commands.registerCommand("nixFlakeTools.enterDevEnv", async () => {
        // Pick flake file from multiple if necessary
        let flakeFile = flakeFiles[0];
        if (flakeFiles.length > 1) {
            const picked = await vscode.window.showQuickPick(flakeFiles);

            // Quit out if the user cancels
            if (picked == undefined) {
                return;
            }

            flakeFile = picked;
        }

        // Chop off the flake.nix
        const flakeDir = flakeFile.substring(0, flakeFile.length - 9);

        // Set up arguments
        const args = ["--log-format", "internal-json", "develop", "-c", "env"];
        if (nixImpure) {
            args.push("--impure");
        }
        if (developInstallable != undefined) {
            args.push(developInstallable);
        }

        // Update status bar
        statusBarItem.text = "$(loading~spin) Building Nix environment...";
        statusBarItem.show();

        // Run Nix command in a clean environment and record changed variables
        let vars = new Map();
        const envProc = child.spawn(nixCommand, args, { cwd: flakeDir, env: { PATH: process.env["PATH"] } });
        envProc.stdout.on("data", (data: Buffer) => {
            for (const line of data.toString().split("\n")) {
                const eq = line.indexOf("=");
                vars.set(line.substring(0, eq), line.substring(eq + 1));
            }
        });

        // TODO Log progress

        envProc.on("close", async _code => {
            // Update status bar
            statusBarItem.text = "$(loading~spin) Injecting Nix environment...";

            // Inject environment variables
            await injectEnvironment(vars);

            // Update status bar
            statusBarItem.text = "$(refresh) Nix environment pending reload";
        });
    }));
}