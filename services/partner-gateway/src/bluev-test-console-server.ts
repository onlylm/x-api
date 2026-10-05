import { createBluevConsoleServer, loadBluevConsoleConfig } from "./bluev-test-console.js";

const config = loadBluevConsoleConfig();
const server = createBluevConsoleServer(config);
server.listen(config.port, config.host);
const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
