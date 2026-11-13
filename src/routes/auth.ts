import { Router } from "express";
import { query, transaction } from "../db.js";
import {
  authRequired,
  hashPassword,
  issueSession,
  requireRole,
  verifyPassword,
  type AppRole,
} from "../auth.js";
import { asyncRoute, requiredString, userOf } from "../http.js";
import { HttpError } from "../auth.js";

const roles: readonly AppRole[] = [
  "user",
  "company_store_manager",
  "superadmin",
];
export const authRouter = Router();

authRouter.post(
  "/register",
  asyncRoute(async (req, res) => {
    const name = requiredString(req.body?.name, "name", 160);
    const email = requiredString(req.body?.email, "email", 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(400, "invalid_email", "Enter a valid email address");
    const password = req.body?.password;
    if (typeof password !== "string")
      throw new HttpError(400, "invalid_password", "Password is required");
    const role = req.body?.role ?? "user";
    if (typeof role !== "string" || !roles.includes(role as AppRole))
      throw new HttpError(
        400,
        "invalid_role",
        "role must be user, company_store_manager, or superadmin",
      );
    const passwordHash = await hashPassword(password);
    const user = await transaction(async (client) => {
      const result = await client.query<{
        id: string;
        name: string;
        email: string;
        role: AppRole;
      }>(
        "INSERT INTO users(name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role",
        [name, email, passwordHash, role],
      );
      const created = result.rows[0]!;
      const tokenSession = issueSession(created.id);
      await client.query(
        "INSERT INTO auth_sessions(id, user_id, expires_at) VALUES ($1, $2, $3)",
        [tokenSession.sessionId, created.id, tokenSession.expiresAt],
      );
      return { ...created, tokenSession };
    });
    const { tokenSession, ...safeUser } = user;
    res.status(201).json({
      user: safeUser,
      accessToken: tokenSession.token,
      tokenType: "Bearer",
      expiresAt: tokenSession.expiresAt,
    });
  }),
);

authRouter.post(
  "/login",
  asyncRoute(async (req, res) => {
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";
    const result = await query<{
      id: string;
      name: string;
      email: string;
      role: AppRole;
      password_hash: string;
    }>(
      "SELECT id, name, email, role, password_hash FROM users WHERE email = $1",
      [email],
    );
    const user = result.rows[0];
    // Verify against a fixed dummy hash for unknown accounts to reduce timing-based enumeration.
    const valid = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyPassword(
          password,
          "scrypt$00000000000000000000000000000000$" + "0".repeat(128),
        );
    if (!user || !valid)
      throw new HttpError(
        401,
        "invalid_credentials",
        "Invalid email or password",
      );
    const session = issueSession(user.id);
    await query(
      "INSERT INTO auth_sessions(id, user_id, expires_at) VALUES ($1, $2, $3)",
      [session.sessionId, user.id, session.expiresAt],
    );
    const { password_hash: _passwordHash, ...safeUser } = user;
    res.json({
      user: safeUser,
      accessToken: session.token,
      tokenType: "Bearer",
      expiresAt: session.expiresAt,
    });
  }),
);

authRouter.post(
  "/logout",
  authRequired,
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    await query(
      "UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [user.sessionId, user.id],
    );
    res.status(204).end();
  }),
);

authRouter.get(
  "/me",
  authRequired,
  asyncRoute(async (req, res) => {
    const user = userOf(req);
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  }),
);

authRouter.patch(
  "/users/:userId/role",
  authRequired,
  requireRole("superadmin"),
  asyncRoute(async (req, res) => {
    const userId = req.params.userId;
    if (typeof userId !== "string" || !/^\d+$/.test(userId))
      throw new HttpError(400, "invalid_user_id", "userId must be numeric");
    const role = req.body?.role;
    if (typeof role !== "string" || !roles.includes(role as AppRole))
      throw new HttpError(
        400,
        "invalid_role",
        "role must be user, company_store_manager, or superadmin",
      );
    const result = await query<{
      id: string;
      name: string;
      email: string;
      role: AppRole;
    }>(
      "UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role",
      [role, userId],
    );
    if (!result.rowCount)
      throw new HttpError(404, "not_found", "User not found");
    res.json({ user: result.rows[0] });
  }),
);
