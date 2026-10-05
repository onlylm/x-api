import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildBluevSandbox, loadBluevSandboxConfig } from "./bluev-sandbox.js";

export async function startBluevSandbox(): Promise<void> {
  const config = loadBluevSandboxConfig();
  const { app } = await buildBluevSandbox(config);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); } catch { process.exitCode = 1; }
  };
  process.once("SIGTERM", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
  try { await app.listen({ host: config.host, port: config.port }); }
  catch { await close(); throw new Error("bluev_sandbox_start_failed"); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void startBluevSandbox().catch(() => {
    // Never print configuration, database paths, provider responses or credentials.
    process.stderr.write("bluev_sandbox_start_failed\n");
    process.exitCode = 1;
  });
}
