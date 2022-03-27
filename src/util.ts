import * as vscode from "vscode";

export function leftTruncate(s: string, len: number): string {
    if (s.length < len) {
        return s;
    } else {
        return "..." + s.substring(s.length - len + 3);
    }
}

export async function promptReload(statusBarItem: vscode.StatusBarItem) {
    // TODO Set status bar action to reload
    statusBarItem.text = "$(refresh) Nix environment pending reload";

    const reload = await vscode.window.showInformationMessage(
        "Reload window now?",
        "Yes",
        "No"
    );
    if (reload == "Yes") {
        vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
}
