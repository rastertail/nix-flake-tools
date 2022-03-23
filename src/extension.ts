import * as vscode from "vscode";

export function activate(ctx: vscode.ExtensionContext) {
    vscode.window.showInformationMessage("Test");
}