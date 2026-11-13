import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PoolClient } from "pg";
import { query } from "./db.js";
import { HttpError, type AuthUser } from "./auth.js";

export type AsyncRoute = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncRoute(fn: AsyncRoute): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

export function userOf(req: Request): AuthUser {
  if (!req.user)
    throw new HttpError(401, "unauthorized", "Authentication is required");
  return req.user;
}

export function positiveInt(
  value: unknown,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const stringValue = String(value ?? "");
  if (!/^\d+$/.test(stringValue))
    throw new HttpError(
      400,
      "invalid_parameter",
      `${name} must be a positive integer`,
    );
  const parsed = Number(stringValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
    throw new HttpError(
      400,
      "invalid_parameter",
      `${name} must be between 1 and ${max}`,
    );
  return parsed;
}

export function pagination(req: Request, maxLimit = 100) {
  const limit =
    req.query.limit === undefined
      ? 50
      : positiveInt(req.query.limit, "limit", maxLimit);
  const page =
    req.query.page === undefined
      ? 1
      : positiveInt(req.query.page, "page", 1_000_000);
  return { limit, page, offset: (page - 1) * limit };
}

export function requiredString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string")
    throw new HttpError(400, "invalid_body", `${name} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength)
    throw new HttpError(
      400,
      "invalid_body",
      `${name} must be between 1 and ${maxLength} characters`,
    );
  return normalized;
}

export function dateString(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new HttpError(
      400,
      "invalid_body",
      `${name} must be a date in YYYY-MM-DD format`,
    );
  }
  return value;
}

export function asProjectNo(value: unknown): number {
  const stringValue = String(value ?? "");
  const match = /^PRJ-(\d{4,})$/i.exec(stringValue);
  return positiveInt(match?.[1], "projectId");
}

export function taskPublicId(
  projectNo: string | number,
  taskNo: string | number,
) {
  return `PRJ-${String(projectNo).padStart(4, "0")}-T-${String(taskNo).padStart(4, "0")}`;
}

export function projectPublicId(projectNo: string | number) {
  return `PRJ-${String(projectNo).padStart(4, "0")}`;
}

export async function projectAccess(
  projectNo: number,
  user: AuthUser,
  requireAdmin = false,
  strictMemberAdmin = false,
  client?: PoolClient,
) {
  const sql = `SELECT p.project_no, p.name, p.planned_start, p.planned_end,
       coalesce(pm.is_admin, false) AS is_admin
     FROM projects p LEFT JOIN project_members pm ON pm.project_no = p.project_no AND pm.user_id = $3
     WHERE p.project_no = $1 AND p.deleted_at IS NULL
       AND ($2::boolean OR pm.user_id IS NOT NULL)`;
  const values = [projectNo, user.role === "superadmin", user.id];
  const result = client
    ? await client.query<{
        project_no: string;
        name: string;
        planned_start: string;
        planned_end: string;
        is_admin: boolean;
      }>(sql, values)
    : await query<{
        project_no: string;
        name: string;
        planned_start: string;
        planned_end: string;
        is_admin: boolean;
      }>(sql, values);
  const project = result.rows[0];
  if (!project) throw new HttpError(404, "not_found", "Project not found");
  if (strictMemberAdmin && !project.is_admin)
    throw new HttpError(
      403,
      "forbidden",
      "A project admin membership is required for this action",
    );
  if (requireAdmin && user.role !== "superadmin" && !project.is_admin)
    throw new HttpError(403, "forbidden", "Project admin access is required");
  return project;
}

export function requireCompanyStore(user: AuthUser) {
  if (user.role !== "company_store_manager" && user.role !== "superadmin") {
    throw new HttpError(404, "not_found", "Resource not found");
  }
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (error instanceof HttpError) {
    return res
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
  }
  const pgError = error as { code?: string; constraint?: string };
  const requestError = error as {
    status?: number;
    statusCode?: number;
    type?: string;
  };
  if (
    error instanceof SyntaxError ||
    requestError?.type === "entity.too.large"
  ) {
    const status = requestError.type === "entity.too.large" ? 413 : 400;
    return res.status(status).json({
      error: {
        code: status === 413 ? "payload_too_large" : "invalid_json",
        message:
          status === 413
            ? "Request body is too large"
            : "Request body must be valid JSON",
      },
    });
  }
  if (requestError?.status === 400 || requestError?.statusCode === 400)
    return res.status(400).json({
      error: {
        code: "invalid_request",
        message: "Request could not be parsed",
      },
    });
  if (pgError?.code === "23505")
    return res.status(409).json({
      error: {
        code: "conflict",
        message: "A record with those values already exists",
      },
    });
  if (pgError?.code === "23503" || pgError?.code === "23514")
    return res.status(400).json({
      error: {
        code: "invalid_reference",
        message: "The requested state violates a data constraint",
      },
    });
  console.error("request failed", error);
  return res.status(500).json({
    error: {
      code: "internal_error",
      message: "An unexpected error occurred",
    },
  });
}

export function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new HttpError(
      400,
      "invalid_parameter",
      `${name} must be one of: ${allowed.join(", ")}`,
    );
  return value as T;
}
