import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../index";

// Defence in depth: Cloudflare Access already gates /admin* and /api/admin*,
// but we verify its JWT ourselves in case an Access rule is misconfigured.

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksTeam: string | undefined;

export type AdminIdentity = { email: string };

export async function verifyAccess(request: Request, env: Env): Promise<AdminIdentity | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.replace(/\/$/, "");
  if (!team || !env.ACCESS_AUD) return null; // fail closed until configured

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  if (!jwks || jwksTeam !== team) {
    jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    jwksTeam = team;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: team,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    const allowed = (env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    return email && allowed.includes(email) ? { email } : null;
  } catch {
    return null;
  }
}
