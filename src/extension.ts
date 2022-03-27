import * as child from "child_process";

import commandExists from "command-exists";
import cdp from "chrome-remote-interface";
import * as vscode from "vscode";

function leftTruncate(s: string, len: number): string {
    if (s.length < len) {
        return s;
    } else {
        return "..." + s.substring(s.length - len + 3);
    }
}

// From https://github.com/NixOS/nix/blob/6a8f1b548fc85af7e065feee93920839ec94fa40/src/libutil/logging.hh
enum ActivityType {
    Unknown = 0,
    CopyPath = 100,
    FileTransfer = 101,
    Realise = 102,
    CopyPaths = 103,
    Builds = 104,
    Build = 105,
    OptimiseStore = 106,
    VerifyPaths = 107,
    Substitute = 108,
    QueryPathInfo = 109,
    PostBuildHook = 110,
    BuildWaiting = 111,
}

enum ResultType {
    FileLinked = 100,
    BuildLogLine = 101,
    UntrustedPath = 102,
    CorruptedPath = 103,
    SetPhase = 104,
    Progress = 105,
    SetExpected = 106,
    PostBuildLogLine = 107,
}

interface LogAction {
    level: number,
    msg: string,
}

interface StartAction {
    id: number,
    level: number,
    type: ActivityType,
    text: string,
    fields: any,
}

interface StopAction {
    id: number,
}

interface ResultAction {
    id: number,
    type: ResultType,
    fields: any,
}

interface ActivityProgress {
    done: number,
    expected: number,
}

interface DisplayString {
    s: string,
    level: number,
}

async function injectEnvironment(vars: Map<string, string>) {
    // Get root process from environment (thanks!)
    const rootProc = parseInt(process.env["VSCODE_PID"]!);

    // Start debug session on the root process
    (process as any)._debugProcess(rootProc);

    // Connect debugger
    const dbg = await cdp({ host: "127.0.0.1", port: 9229 });

    // Potentially restore old environment, otherwise save old environment
    await dbg.Runtime.evaluate({
        expression: `
        if (typeof oldEnv !== "undefined") {
            process.env = oldEnv;
        } else {
            oldEnv = Object.assign({}, process.env);
        }
    ` });

    // Apply environment variables
    for (const [name, value] of vars) {
        // Escape quotes and backslashes in variable values
        value.replace(/\\/g, "\\\\");
        value.replace(/"/g, "\\\"");

        await dbg.Runtime.evaluate({ expression: `process.env["${name}"] = "${value}";` });
    }

    // Close debugger
    await dbg.close();
}

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

    // Get flake directory (at least one assumed to exist by activation events)
    const flakeFiles = (await vscode.workspace.findFiles("flake.nix", "")).map(uri => uri.fsPath);

    // Register commands
    ctx.subscriptions.push(vscode.commands.registerCommand("nixFlakeTools.enterDevEnv", async () => {
        // Load configuration options
        const config = vscode.workspace.getConfiguration("nixFlakeTools");
        const developInstallable = config.get<string>("devInstallable");
        const allowUnfree = config.get("allowUnfree", false);
        const allowBroken = config.get("allowBroken", false);
        const allowUnsupported = config.get("allowUnsupported", false);
        const allowInsecure = config.get("allowInsecure", false);

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
        const args = ["--log-format", "internal-json", "develop"];
        if (allowUnfree || allowBroken || allowUnsupported || allowInsecure) {
            args.push("--impure");
        }
        if (developInstallable != undefined) {
            args.push(developInstallable);
        }
        args.push("-c", "env");

        // Set up environment variables
        const envProcEnv = {
            PATH: process.env["PATH"],
            NIXPKGS_ALLOW_UNFREE: allowUnfree ? "1" : "0",
            NIXPKGS_ALLOW_BROKEN: allowBroken ? "1" : "0",
            NIXPKGS_ALLOW_UNSUPPORTED_SYSTEM: allowUnsupported ? "1" : "0",
            NIXPKGS_ALLOW_INSECURE: allowInsecure ? "1" : "0",
        };

        // Update status bar
        statusBarItem.text = "$(loading~spin) Building Nix environment...";
        statusBarItem.show();

        // Run Nix command in a clean environment and record changed variables
        let vars = new Map<string, string>();
        const envProc = child.spawn(nixCommand, args, { cwd: flakeDir, env: envProcEnv });
        envProc.stdout.on("data", (data: Buffer) => {
            for (const line of data.toString().split('\n')) {
                const eq = line.indexOf("=");
                vars.set(line.substring(0, eq), line.substring(eq + 1));
            }
        });

        // Add special variable to remember that we are in a VS Code managed environment
        vars.set("VSCODE_IN_FLAKE_ENV", "1");

        // Log progress
        const progress = {
            activities: new Map<number, ActivityProgress>(),
            done: 0,
            expected: 0,
        };
        const activityStrings = new Map<number, DisplayString>();
        let displayId = -1;
        envProc.stderr.on("data", (data: Buffer) => {
            for (const line of data.toString().split('\n').filter(s => s.startsWith("@nix "))) {
                const rawAction: any = JSON.parse(line.substring(5));
                switch (rawAction.action) {
                    // Show popups for errors
                    case "msg": {
                        const action = rawAction as LogAction;
                        if (action.level == 0) {
                            vscode.window.showErrorMessage(action.msg);
                        }
                        break;
                    }

                    // Track relevant progress activities
                    case "start": {
                        const action = rawAction as StartAction;

                        // Create message string for relevant activities
                        let msg: string | undefined;
                        if (action.type == ActivityType.FileTransfer) {
                            msg = "Downloading " + leftTruncate(action.fields[0], 24);
                        } else if (action.type == ActivityType.CopyPath) {
                            msg = "Fetching " + leftTruncate(action.fields[0], 24);
                        } else if (action.type == ActivityType.Build) {
                            msg = "Building " + leftTruncate(action.fields[0], 24);
                        }

                        // Update activity strings and display ID
                        if (msg != undefined) {
                            activityStrings.set(action.id, { s: msg, level: action.level });

                            const displayed = activityStrings.get(displayId);
                            if (displayed == undefined || action.level <= displayed.level) {
                                displayId = action.id;
                            }
                        }

                        // Start tracking `Builds` and `CopyPaths` activities
                        if (action.type == ActivityType.Builds || action.type == ActivityType.CopyPaths) {
                            progress.activities.set(action.id, {
                                done: 0,
                                expected: 0,
                            });
                        }

                        break;
                    }
                    case "stop": {
                        const action = rawAction as StopAction;

                        // Remove activity from activity strings, potentially
                        // updating display string to another activity
                        activityStrings.delete(action.id);
                        if (displayId == action.id) {
                            let nextBestLevel = 999;
                            let nextBestId = -1;

                            for (const [id, { level }] of activityStrings) {
                                if (level < nextBestLevel) {
                                    nextBestLevel = level;
                                    nextBestId = id;
                                }
                            }

                            displayId = nextBestId;
                        }

                        // Flush progress from `Builds` and `CopyPaths`
                        const prog = progress.activities.get(action.id);
                        if (prog != undefined) {
                            progress.done += prog.done;
                            progress.expected += prog.done;
                        }
                        progress.activities.delete(action.id);

                        break;
                    }
                    case "result": {
                        const action = rawAction as ResultAction;

                        // Potentially update display ID
                        // TODO Filter by result type?
                        const str = activityStrings.get(action.id);
                        const displayStr = activityStrings.get(displayId);
                        if (str != undefined && (displayStr == undefined || str.level <= displayStr.level)) {
                            displayId = action.id;
                        }

                        // Update progress on `Builds` and `CopyPaths`
                        const prog = progress.activities.get(action.id);
                        if (prog != undefined) {
                            if (action.type == ResultType.SetExpected) {
                                prog.expected = action.fields[1];
                            } else if (action.type == ResultType.Progress) {
                                prog.done = action.fields[0];
                                prog.expected = action.fields[1];
                            }
                        }

                        break;
                    }
                }
            }
        });

        // Only update status bar every 100ms
        const progressUpdater = setInterval(() => {
            // Tally up total done and expected activities
            let totalDone = progress.done;
            let totalExpected = progress.expected;
            for (const prog of progress.activities.values()) {
                totalDone += prog.done;
                totalExpected += prog.expected;
            }

            // Update status bar
            // TODO Show tooltip with full store path
            const displayString = activityStrings.get(displayId);
            if (displayString != undefined) {
                statusBarItem.text = `$(loading~spin) (${totalDone}/${totalExpected}) ${displayString.s}`;
            } else {
                statusBarItem.text = `$(loading~spin) (${totalDone}/${totalExpected}) Building Nix environment...`;
            }
        }, 100);

        // Wait for process to finish
        const status = await new Promise((resolve, _reject) => {
            envProc.on("close", resolve);
        });

        // Stop updating progress
        clearTimeout(progressUpdater);

        if (status == 0) {
            // Update status bar
            statusBarItem.text = "$(loading~spin) Injecting Nix environment...";

            // Inject environment variables
            await injectEnvironment(vars);

            // Update status bar
            statusBarItem.text = "$(refresh) Nix environment pending reload";
        } else {
            // Update status bar and alert user
            statusBarItem.text = "$(error) Nix environment failed";
            vscode.window.showErrorMessage(`Nix returned non-zero status code (${status})`);
        }
    }));
}