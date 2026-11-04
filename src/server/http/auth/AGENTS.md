# Hosted authentication

## Purpose

Authenticate hosted HTTP requests without persistent OAuth storage.

## Ownership

Owns `index.ts` (the `CreateHostedAuth` factory and routes), `principals.ts` (startup validation and HMAC lookup),
`values.ts` (typed HS256 values), and `provider.ts` (SDK OAuth provider, form and audit events). The transport owns Host
validation and mounts `requireAuth` on `/mcp`; `../contract.ts` is the shared interface.

## Local Contracts

- Use SDK OAuth routing, metadata, PKCE validation and bearer middleware. Public DCR clients only; never issue secrets.
- The signing key is base64 decoded. Verify algorithm, issuer, audience, type and expiry for each signed value.
- Client IDs survive restarts; other signed values expire. Current principal existence and passcode HMAC version revoke
  access and refresh tokens. Only one-time codes are stored in memory and consumed at the SDK's first PKCE lookup.
- All passcode comparisons use equal-length HMACs and visit every principal.
- Guessing failures share one IP budget across passcode submission, token exchange and bearer authentication.
- Startup errors name the variable and never reflect secret values. OAuth failures are generic.
- Hosted auth audit events write one JSON line directly to stderr, because the source-wide logger formats text and
  suppresses ordinary events in tests. Include only event, path/IP, or a refused redirect URI; never credentials.

## Work Guidance

Follow `docs/HOSTED_DEPLOYMENT_SPEC.md` Configuration and Authentication. Keep transport implementation outside this
module and do not change `../contract.ts` without coordinating its consumer.

## Verification

Run `npm run build`, then `npx vitest run tests/server/http`, plus typecheck and lint. Auth tests dispatch real
IncomingMessage/ServerResponse objects through Express using in-memory sockets, so no listener is required.

## Child DOX Index

None.
