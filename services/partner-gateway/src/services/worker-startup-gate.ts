import { existsSync } from "node:fs";

/** Standby HTTP instances may serve traffic before the old workers are safely retired. */
export function gateWorkerStartup(start: () => void, gateFile = process.env.QUEFA_WORKER_GATE_FILE): () => void {
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  const check = () => {
    if (started || (gateFile && !existsSync(gateFile))) return;
    started = true;
    if (timer) clearInterval(timer);
    start();
  };
  check();
  if (!started) {
    timer = setInterval(check, 1_000);
    timer.unref();
  }
  return () => { started = true; if (timer) clearInterval(timer); };
}
