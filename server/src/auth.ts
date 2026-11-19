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
const posSessionCookie = "smart_pos_pos_session";
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
      posUser?: AuthUser;
      posSessionId?: string;
    }
  }
}

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});
export const posLoginSchema = z.object({
  username: z.string().trim().min(4).max(100),
  password: z.string().min(4).max(200),
}).strict();

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

export async function posLogin(req: Request, res: Response): Promise<void> {
  const input = posLoginSchema.parse(req.body);
  const [users] = await pool.execute<Array<UserRow & {
    pos_failed_attempts: number; pos_locked_until: Date | null;
  }>>(
    `SELECT id, name, email, branch_id, password_hash, is_active,
            pos_failed_attempts, pos_locked_until
     FROM users WHERE pos_username = ? LIMIT 1`,
    [input.username.toLowerCase()],
  );
  const user = users[0];
  if (!user || !user.is_active) {
    res.status(401).json({ error: "POS username or password is incorrect." });
    return;
  }
  if (user.pos_locked_until && new Date(user.pos_locked_until).getTime() > Date.now()) {
    res.status(423).json({ error: "This POS account is temporarily locked. Try again later." });
    return;
  }
  const roles = await query<Array<{ name: string } & RowDataPacket>>(
    "SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?",
    [user.id],
  );
  const roleNames = roles.map((role) => role.name);
  if (!roleNames.some((role) => ["admin", "manager", "cashier"].includes(role))) {
    res.status(403).json({ error: "This account is not authorized for POS access." });
    return;
  }
  if (!(await bcrypt.compare(input.password, user.password_hash))) {
    const attempts = Number(user.pos_failed_attempts ?? 0) + 1;
    if (attempts >= 5) {
      await execute(
        "UPDATE users SET pos_failed_attempts = ?, pos_locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?",
        [attempts, user.id],
      );
      res.status(423).json({ error: "Too many failed attempts. This POS account is locked for 15 minutes." });
      return;
    }
    await execute("UPDATE users SET pos_failed_attempts = ? WHERE id = ?", [attempts, user.id]);
    res.status(401).json({ error: "POS username or password is incorrect." });
    return;
  }
  await execute("UPDATE users SET pos_failed_attempts = 0, pos_locked_until = NULL WHERE id = ?", [user.id]);
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  await execute("INSERT INTO pos_sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [sessionId, user.id, expiresAt]);
  await execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'pos.login', 'user', ?)",
    [user.id, String(user.id)],
  );
  res.cookie(posSessionCookie, sessionId, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    expires: expiresAt, path: "/",
  });
  res.json({ cashier: { id: user.id, name: user.name, username: input.username.toLowerCase(), branchId: user.branch_id, roles: roleNames } });
}

export async function authenticatePos(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.[posSessionCookie];
    if (!sessionId) { res.status(401).json({ error: "POS authentication required." }); return; }
    const rows = await query<Array<{
      id: number; name: string; email: string; branch_id: number; pos_username: string;
    } & RowDataPacket>>(
      `SELECT u.id, u.name, u.email, u.branch_id, u.pos_username
       FROM users u JOIN pos_sessions s ON s.user_id = u.id
       WHERE s.id = ? AND u.is_active = TRUE AND s.expires_at > NOW() LIMIT 1`,
      [sessionId],
    );
    if (!rows[0]) { res.status(401).json({ error: "POS session expired. Authenticate again." }); return; }
    const roles = await query<Array<{ name: string } & RowDataPacket>>(
      "SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?",
      [rows[0].id],
    );
    const roleNames = roles.map((role) => role.name);
    if (!roleNames.some((role) => ["admin", "manager", "cashier"].includes(role))) {
      res.status(403).json({ error: "This account is not authorized for POS access." });
      return;
    }
    req.posUser = { id: rows[0].id, name: rows[0].name, email: rows[0].email, branchId: rows[0].branch_id, roles: roleNames };
    req.posSessionId = sessionId;
    await execute("UPDATE pos_sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [sessionId]);
    next();
  } catch (error) {
    next(error);
  }
}

export async function posLogout(req: Request, res: Response): Promise<void> {
  if (req.posUser && req.posSessionId) {
    await execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'pos.logout', 'user', ?)",
      [req.posUser.id, String(req.posUser.id)],
    );
    await execute("DELETE FROM pos_sessions WHERE id = ?", [req.posSessionId]);
  }
  res.clearCookie(posSessionCookie, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.status(204).end();
}
