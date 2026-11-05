import { createApiApp } from "./api.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3010);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

const app = createApiApp();
const server = app.listen(port, host, () => console.log(`API service listening on ${host}:${port}`));
server.on("error", (error) => {
  console.error(`API service failed: ${error.message}`);
  process.exitCode = 1;
});
