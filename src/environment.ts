import cdp from "chrome-remote-interface";

export async function injectEnvironment(vars: Map<string, string>) {
    // Get root process from environment (thanks!)
    const rootProc = parseInt(process.env["VSCODE_PID"]!);

    // Start debug session on the root process
    (process as any)._debugProcess(rootProc);

    // Connect debugger
    const dbg = await cdp({ host: "127.0.0.1", port: 9229 });

    // Potentially restore old environment and save old environment
    await dbg.Runtime.evaluate({
        expression: `
        if (typeof oldEnv !== "undefined") {
            for (const name in process.env) {
                delete process.env[name];
            }
            Object.assign(process.env, oldEnv);
        }
        oldEnv = Object.assign({}, process.env);
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