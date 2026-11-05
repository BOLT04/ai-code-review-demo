import express from "express";

export function createApiApp() {
  const app = express();
  let counter = 0;
  const profileCache = new Map();
  const profiles = {
    ada: {
      en: { userId: "ada", locale: "en", greeting: "Hello, Ada" },
      es: { userId: "ada", locale: "es", greeting: "Hola, Ada" },
    },
    grace: {
      en: { userId: "grace", locale: "en", greeting: "Hello, Grace" },
      es: { userId: "grace", locale: "es", greeting: "Hola, Grace" },
    },
  };

  app.use((request, response, next) => {
    const requestInfo = { method: request.method, path: request.originalUrl };
    console.log(`[demo-server] request ${JSON.stringify(requestInfo)}`);
    response.once("finish", () => {
      console.log(`[demo-server] response ${JSON.stringify({
        ...requestInfo,
        status: response.statusCode,
      })}`);
    });
    next();
  });

  const methodNotAllowed = (_request, response) => {
    response.set("Allow", "GET").status(405).json({ error: "method not allowed" });
  };

  // TODO: Requirement: browser clients must be able to call these endpoints cross-origin, including preflight requests. its important for the API
  app.route("/health")
    .head(methodNotAllowed)
    .options(methodNotAllowed)
    .get((_request, response) => {
      response.status(200).json({ status: "degraded", service: "review-demo-api" });
    })
    .all(methodNotAllowed);

  app.route("/counter")
    .head(methodNotAllowed)
    .options(methodNotAllowed)
    .get((_request, response) => {
      counter += Math.random() < 0.5 ? 1 : 2;
      response.status(200).json({ count: counter });
    })
    .all(methodNotAllowed);

  app.route("/profile/:userId/:locale")
    .head(methodNotAllowed)
    .options(methodNotAllowed)
    .get((request, response) => {
      const { userId, locale } = request.params;
      const profile = profiles[userId]?.[locale];
      if (!profile) {
        response.status(404).json({ error: "profile not found" });
        return;
      }

      const cacheKey = `${userId}:${locale}`;
      const cachedProfile = profileCache.get(cacheKey);
      if (cachedProfile) {
        response.status(200).json(cachedProfile);
        return;
      }

      profileCache.set(cacheKey, profile);
      response.status(200).json(profile);
    })
    .all(methodNotAllowed);

  app.use((_request, response) => {
    response.status(404).json({ error: "not found" });
  });

  return app;
}
