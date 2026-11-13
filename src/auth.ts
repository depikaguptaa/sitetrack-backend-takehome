import {
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { query } from "./db.js";

const scrypt = promisify(nodeScrypt);
const configuredJwtSecret = process.env.JWT_SECRET?.trim();
const JWT_SECRET =
  configuredJwtSecret ??
  (process.env.NODE_ENV === "production"
    ? ""
    : "development-only-secret-change-before-deployment");
const configuredTtl = Number(process.env.JWT_TTL_DAYS ?? 30);
const JWT_TTL_DAYS = Number.isFinite(configuredTtl)
  ? Math.min(365, Math.max(1, configuredTtl))
  : 30;
if (
  process.env.NODE_ENV === "production" &&
  (!configuredJwtSecret || configuredJwtSecret.length < 32)
)
  throw new Error(
    "JWT_SECRET must be configured with at least 32 characters in production",
  );

export type AppRole = "user" | "company_store_manager" | "superadmin";
export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  sessionId: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10 || password.length > 256)
    throw new HttpError(
      400,
      "invalid_password",
      "Password must be 10 to 256 characters",
    );
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, salt, expectedHex] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signToken(payload: Record<string, unknown>): string {
  const head = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${head}.${body}`;
  const signature = createHmac("sha256", JWT_SECRET)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

export function issueSession(userId: string): {
  sessionId: string;
  token: string;
  expiresAt: Date;
} {
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((now + JWT_TTL_DAYS * 86_400) * 1000);
  const token = signToken({
    iss: "sitetrack",
    sub: userId,
    sid: sessionId,
    iat: now,
    exp: Math.floor(expiresAt.getTime() / 1000),
  });
  return { sessionId, token, expiresAt };
}

function verifyToken(
  token: string,
): { userId: string; sessionId: string } | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2])
    return undefined;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", JWT_SECRET).update(unsigned).digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return undefined;
  try {
    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    ) as { alg?: string };
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { iss?: string; sub?: string; sid?: string; exp?: number };
    if (
      header.alg !== "HS256" ||
      payload.iss !== "sitetrack" ||
      !payload.sub ||
      !payload.sid ||
      !payload.exp ||
      payload.exp <= Date.now() / 1000
    )
      return undefined;
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    return undefined;
  }
}

export async function authRequired(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const value = req.header("authorization");
    if (!value?.startsWith("Bearer "))
      throw new HttpError(
        401,
        "unauthorized",
        "A valid bearer token is required",
      );
    const claims = verifyToken(value.slice(7));
    if (!claims)
      throw new HttpError(
        401,
        "unauthorized",
        "A valid bearer token is required",
      );
    // Read role and session state from Postgres on each request so logout and role changes take effect immediately.
    const result = await query<{
      id: string;
      name: string;
      email: string;
      role: AppRole;
    }>(
      `SELECT u.id, u.name, u.email, u.role
       FROM users u JOIN auth_sessions s ON s.user_id = u.id
       WHERE u.id = $1 AND s.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [claims.userId, claims.sessionId],
    );
    const user = result.rows[0];
    if (!user)
      throw new HttpError(
        401,
        "unauthorized",
        "A valid bearer token is required",
      );
    req.user = { ...user, sessionId: claims.sessionId };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...roles: AppRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role))
      return next(
        new HttpError(403, "forbidden", "This action is not permitted"),
      );
    next();
  };
}

export function parseBearerClaims(token: string) {
  return verifyToken(token);
}
