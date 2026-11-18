import "./env.js";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { execute, pool, query } from "./db.js";

function getJwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("JWT_SECRET must be set to at least 32 characters.");
  return value;
}
const secret = getJwtSecret();

const sessionCookie = "smart_pos_session";
const ttl = process.env.JWT_TTL ?? "8h";

type UserRow = RowDataPacket & {
  id: number;
  name: string;
  email: string;
  branch_id: number;
  password_hash: string;
  is_active: number;
};

export type AuthUser = { id: number; name: string; email: string; branchId: number; roles: string[] };
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

export async function login(req: Request, res: Response): Promise<void> {
  const input = loginSchema.parse(req.body);
  const [users] = await pool.execute<UserRow[]>(
    "SELECT id, name, email, branch_id, password_hash, is_active FROM users WHERE email = ? LIMIT 1",
    [input.email.toLowerCase()],
  );
  const user = users[0];
  if (!user || !user.is_active || !(await bcrypt.compare(input.password, user.password_hash))) {
    res.status(401).json({ error: "Email or password is incorrect." });
    return;
  }

  const roles = await query<Array<{ name: string } & import("mysql2").RowDataPacket>>(
    "SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?",
    [user.id],
  );
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await execute("INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [
    sessionId,
    user.id,
    expiresAt,
  ]);
  await execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'auth.login', 'user', ?)",
    [user.id, String(user.id)],
  );
  const token = jwt.sign({ sid: sessionId }, secret, { subject: String(user.id), expiresIn: ttl as jwt.SignOptions["expiresIn"] });
  res.cookie(sessionCookie, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
  res.json({ user: { id: user.id, name: user.name, email: user.email, branchId: user.branch_id, roles: roles.map((role) => role.name) } });
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[sessionCookie];
    if (!token) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    const claims = jwt.verify(token, secret);
    if (typeof claims === "string" || typeof claims.sub !== "string" || typeof claims.sid !== "string") {
      res.status(401).json({ error: "Session token is invalid." });
      return;
    }
    const rows = await query<Array<{
      id: number; name: string; email: string; branch_id: number; session_id: string;
    } & import("mysql2").RowDataPacket>>(
      `SELECT u.id, u.name, u.email, u.branch_id, s.id AS session_id
       FROM users u JOIN auth_sessions s ON s.user_id = u.id
       WHERE u.id = ? AND s.id = ? AND u.is_active = TRUE AND s.expires_at > NOW() LIMIT 1`,
      [Number(claims.sub), claims.sid],
    );
    if (!rows[0]) {
      res.status(401).json({ error: "Session expired. Please sign in again." });
      return;
    }
    const roles = await query<Array<{ name: string } & import("mysql2").RowDataPacket>>(
      "SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?",
      [rows[0].id],
    );
    req.user = {
      id: rows[0].id,
      name: rows[0].name,
      email: rows[0].email,
      branchId: rows[0].branch_id,
      roles: roles.map((role) => role.name),
    };
    req.sessionId = claims.sid;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRoles(...allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.roles.some((role) => allowed.includes(role))) {
      res.status(403).json({ error: "You do not have permission to perform this action." });
      return;
    }
    next();
  };
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.sessionId && req.user) {
    await execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'auth.logout', 'user', ?)",
      [req.user.id, String(req.user.id)],
    );
    await execute("DELETE FROM auth_sessions WHERE id = ?", [req.sessionId]);
  }
  res.clearCookie(sessionCookie, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.status(204).end();
}

export function currentUser(req: Request, res: Response): void {
  res.json({ user: req.user });
}
