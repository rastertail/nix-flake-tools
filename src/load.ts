import * as child from "child_process";

import * as vscode from "vscode";

import { injectEnvironment } from "./environment";
import * as nix from "./nix";
import { leftTruncate } from "./util";

interface ActivityProgress {
    done: number,
    expected: number,
}

interface DisplayString {
    s: string,
    level: number,
}

export async function loadEnvironment(statusBarItem: vscode.StatusBarItem) {
    // Load configuration options
    const config = vscode.workspace.getConfiguration("nixFlakeTools");
    const nixCommand = config.get("nixCommand", "nix");
    const developInstallable = config.get<string>("devInstallable");
    const allowUnfree = config.get("allowUnfree", false);
    const allowBroken = config.get("allowBroken", false);
    const allowUnsupported = config.get("allowUnsupported", false);
    const allowInsecure = config.get("allowInsecure", false);

    // Get flake paths
    const flakeFiles = (await vscode.workspace.findFiles("flake.nix", "")).map(uri => uri.fsPath);

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
                    const action = rawAction as nix.LogAction;
                    if (action.level == 0) {
                        vscode.window.showErrorMessage(action.msg);
                    }
                    break;
                }

                // Track relevant progress activities
                case "start": {
                    const action = rawAction as nix.StartAction;

                    // Create message string for relevant activities
                    let msg: string | undefined;
                    if (action.type == nix.ActivityType.FileTransfer) {
                        msg = "Downloading " + leftTruncate(action.fields[0], 24);
                    } else if (action.type == nix.ActivityType.CopyPath) {
                        msg = "Fetching " + leftTruncate(action.fields[0], 24);
                    } else if (action.type == nix.ActivityType.Build) {
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
                    if (action.type == nix.ActivityType.Builds || action.type == nix.ActivityType.CopyPaths) {
                        progress.activities.set(action.id, {
                            done: 0,
                            expected: 0,
                        });
                    }

                    break;
                }
                case "stop": {
                    const action = rawAction as nix.StopAction;

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
                    const action = rawAction as nix.ResultAction;

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
                        if (action.type == nix.ResultType.SetExpected) {
                            prog.expected = action.fields[1];
                        } else if (action.type == nix.ResultType.Progress) {
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
}