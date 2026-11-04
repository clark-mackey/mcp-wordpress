import express, { type RequestHandler, type ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { CreateHostedAuth } from "../contract.js";
import { parseConfiguration } from "./principals.js";
import { PasscodeOAuthProvider, audit, passcodePage } from "./provider.js";

export const createHostedAuth: CreateHostedAuth = (options) => {
  const config = parseConfiguration(options);
  const issuer = options.publicBaseUrl.origin;
  const provider = new PasscodeOAuthProvider(config, issuer);
  const resource = new URL(`${issuer}/mcp`);
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => (req.path === "/mcp" ? Boolean(req.auth) : res.statusCode < 400),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "too_many_requests" });
    },
  });
  const failures: RequestHandler = (req, res, next) => {
    const path = req.originalUrl.split("?")[0];
    res.once("finish", () => {
      if (res.statusCode >= 400 && res.statusCode !== 429 && (req.path !== "/mcp" || !req.auth))
        audit("auth_failure", { ip: req.ip ?? "unknown", path });
    });
    next();
  };
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    expectedResource: resource,
  });
  const requireAuth: RequestHandler = (req, res, next) => {
    failures(req, res, () =>
      limiter(req, res, () =>
        bearer(req, res, () => {
          res.locals.principal = config.principals.get(req.auth!.extra!.principal as string);
          next();
        }),
      ),
    );
  };
  return {
    principals: config.principals,
    requireAuth,
    install(app) {
      app.use(["/token", "/authorize/passcode"], failures, limiter);
      app.post("/authorize/passcode", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
        res.set("Cache-Control", "no-store");
        try {
          const transaction = typeof req.body?.transaction === "string" ? req.body.transaction : "";
          const claims = await provider.transaction(transaction);
          const principal = config.matchPasscode(typeof req.body?.passcode === "string" ? req.body.passcode : "");
          if (!principal) {
            passcodePage(res.status(401), transaction, claims.redirect_uri as string, true);
            return;
          }
          res.redirect(302, provider.complete(claims, principal));
        } catch {
          res.status(401).json({ error: "invalid_request" });
        }
      });
      // Refuse a removed app before the SDK could redirect an error to that app.
      app.use("/authorize", express.urlencoded({ extended: false }), async (req, res, next) => {
        const params = req.method === "POST" ? req.body : req.query;
        let uri = params?.redirect_uri;
        if (uri === undefined && typeof params?.client_id === "string") {
          const client = await provider.clientsStore.getClient(params.client_id);
          if (client?.redirect_uris.length === 1) uri = client.redirect_uris[0];
        }
        if (typeof uri === "string") {
          try {
            provider.checkRedirect(uri);
          } catch {
            res.status(400).json({ error: "invalid_redirect_uri" });
            return;
          }
        }
        next();
      });
      app.use(["/register", "/authorize", "/token"], (_req, res, next) => {
        const json = res.json.bind(res);
        res.json = (body) =>
          json(
            res.statusCode >= 400 && body?.error
              ? { error: body.error, error_description: "Authentication request failed" }
              : body,
          );
        next();
      });
      // Validate redirect strings before the SDK's URL schema can return a different DCR error.
      app.use("/register", express.json({ limit: "16kb" }), (req, res, next) => {
        if (Array.isArray(req.body?.redirect_uris)) {
          for (const uri of req.body.redirect_uris) {
            if (typeof uri !== "string") continue;
            try {
              provider.checkRedirect(uri);
            } catch {
              res.status(400).json({ error: "invalid_redirect_uri" });
              return;
            }
          }
        }
        next();
      });
      app.use(
        mcpAuthRouter({
          provider,
          issuerUrl: options.publicBaseUrl,
          resourceServerUrl: resource,
          tokenOptions: { rateLimit: false },
        }),
      );
      const invalidBody: ErrorRequestHandler = (_error, _req, res, _next) => {
        res.status(400).json({ error: "invalid_request" });
      };
      app.use(["/register", "/authorize", "/authorize/passcode", "/token"], invalidBody);
    },
  };
};
