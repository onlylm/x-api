import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = await buildApp(config);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
