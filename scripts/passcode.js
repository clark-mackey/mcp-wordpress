import { randomBytes } from "node:crypto";

// Generate a new hosted sign-in passcode; never persist it.
process.stdout.write(`${randomBytes(32).toString("base64url")}\n`);
