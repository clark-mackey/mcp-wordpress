import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export type ValueType = "client" | "authz" | "access" | "refresh";

/** Separate audiences and protected types prevent one kind of credential being used as another. */
export class SignedValues {
  constructor(
    private readonly key: Uint8Array,
    private readonly issuer: string,
  ) {}

  private audience(type: ValueType): string {
    return { client: "register", authz: "authorize", access: `${this.issuer}/mcp`, refresh: "token" }[type];
  }

  async sign(type: ValueType, claims: JWTPayload): Promise<string> {
    let value = new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: type })
      .setIssuer(this.issuer)
      .setAudience(this.audience(type))
      .setIssuedAt();
    if (type !== "client") value = value.setExpirationTime({ authz: "10m", access: "1h", refresh: "30d" }[type]);
    return value.sign(this.key);
  }

  async verify(type: ValueType, token: string): Promise<JWTPayload> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: this.issuer,
        audience: this.audience(type),
        requiredClaims: type === "client" ? ["iat"] : ["iat", "exp"],
      });
      if (protectedHeader.typ !== type) throw new InvalidGrantError("Invalid credential");
      return payload;
    } catch {
      throw new InvalidGrantError("Invalid credential");
    }
  }
}
