import http from "node:http";

http.createServer((req, res) => {
  const health = req.method === "GET" && req.url === "/health";
  if (!health) console.warn(`Inventory stub: ${req.method} ${req.url} is not implemented`);
  res.writeHead(health ? 200 : 501, { "content-type": "application/json" });
  res.end(JSON.stringify(health
    ? { status: "ok", implementation: "stub" }
    : { error: "Inventory application is not implemented", implementation: "stub" }));
}).listen(Number(process.env.PORT ?? 3000), () => console.log("inventory stub listening"));
