import "./env.js";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { execute, pool, query, withTransaction } from "./db.js";
import { revokeScannerPairingsForPosSession } from "./mobile-scanner.js";

function getJwtSecret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("JWT_SECRET must be set to at least 32 characters.");
  return value;
}
const secret = getJwtSecret();

const sessionCookie = "smart_pos_session";
const posSessionCookie = "smart_pos_pos_session";
const cookieSameSite: "lax" | "none" = process.env.NODE_ENV === "production" ? "none" : "lax";
const ttl = process.env.JWT_TTL ?? "8h";
const landingModuleIds = new Set([
  "dashboard", "pos", "sales", "products", "inventory", "purchases", "suppliers",
  "customers", "expenses", "shifts", "reports",
  "branches", "sync_monitor", "backups", "price_history", "notifications", "permissions", "receipts", "comparisons",
  "cashier_monitoring",
]);

type UserRow = RowDataPacket & {
  id: number;
  name: string;
  email: string;
  username: string | null;
  branch_id: number;
  password_hash: string;
  pos_username: string | null;
  default_landing: string | null;
  must_change_password: number;
  main_failed_attempts: number;
  main_locked_until: Date | null;
  is_active: number;
};

export type AuthUser = {
  id: number; name: string; email: string; branchId: number; roles: string[];
  posUsername?: string; modules?: string[]; defaultLanding?: string; mustChangePassword?: boolean;
};
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
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(4).max(200),
}).strict();
export const posLoginSchema = z.object({
  username: z.string().trim().min(4).max(100),
  password: z.string().min(4).max(200),
}).strict();

export async function login(req: Request, res: Response): Promise<void> {
  const input = loginSchema.parse(req.body);
  const identifier = input.identifier.toLowerCase();
  const isEmail = identifier.includes("@");
  const [users] = await pool.execute<UserRow[]>(
    `SELECT id, name, email, username, pos_username, branch_id, password_hash,
            default_landing, must_change_password, main_failed_attempts,
            main_locked_until, is_active
     FROM users WHERE ${isEmail ? "email" : "username"} = ? LIMIT 1`,
    [identifier],
  );
  const user = users[0];
  if (!user || !user.is_active) {
    await execute(
      "INSERT INTO login_history (user_id, identifier, success, ip_address, user_agent) VALUES (?, ?, FALSE, ?, ?)",
      [user?.id ?? null, identifier, req.ip ?? null, req.get("user-agent")?.slice(0, 500) ?? null],
    );
    res.status(401).json({ error: "Username/email or password is incorrect." });
    return;
  }
  const roles = await query<Array<{ name: string } & import("mysql2").RowDataPacket>>(
    "SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?",
    [user.id],
  );
  const roleNames = roles.map((role) => role.name);
  if (isEmail && !roleNames.includes("admin")) {
    await execute(
      "INSERT INTO login_history (user_id, identifier, success, ip_address, user_agent) VALUES (?, ?, FALSE, ?, ?)",
      [user.id, identifier, req.ip ?? null, req.get("user-agent")?.slice(0, 500) ?? null],
    );
    res.status(403).json({ error: "Email login is available only to administrator accounts." });
    return;
  }
  if (!isEmail && roleNames.includes("admin")) {
    await execute(
      "INSERT INTO login_history (user_id, identifier, success, ip_address, user_agent) VALUES (?, ?, FALSE, ?, ?)",
      [user.id, identifier, req.ip ?? null, req.get("user-agent")?.slice(0, 500) ?? null],
    );
    res.status(403).json({ error: "Administrator accounts must sign in with their email address." });
    return;
  }
  if (user.main_locked_until && new Date(user.main_locked_until).getTime() > Date.now()) {
    await execute(
      "INSERT INTO login_history (user_id, identifier, success, ip_address, user_agent) VALUES (?, ?, FALSE, ?, ?)",
      [user.id, identifier, req.ip ?? null, req.get("user-agent")?.slice(0, 500) ?? null],
    );
    res.status(423).json({ error: "This account is temporarily locked. Try again later." });
    return;
  }
  if (!(await bcrypt.compare(input.password, user.password_hash))) {
    const attempts = Number(user.main_failed_attempts ?? 0) + 1;
    if (attempts >= 5) {
      await execute(
        "UPDATE users SET main_failed_attempts=?, main_locked_until=DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id=?",
        [attempts, user.id],
      );
    } else {
      await execute("UPDATE users SET main_failed_attempts=? WHERE id=?", [attempts, user.id]);
    }
    await execute(
      "INSERT INTO login_history (user_id, identifier, success, ip_address, user_agent) VALUES (?, ?, FALSE, ?, ?)",
      [user.id, identifier, req.ip ?? null, req.get("user-agent")?.slice(0, 500) ?? null],
    );
    res.status(attempts >= 5 ? 423 : 401).json({
      error: attempts >= 5
        ? "Too many failed attempts. This account is locked for 15 minutes."
        : "Username/email or password is incorrect.",
    });
    return;
  }
  await execute(
    "UPDATE users SET main_failed_attempts=0, main_locked_until=NULL WHERE id=?",
    [user.id],
  );
  await execute(
    "INSERT INTO login_history (user_id, identifier, success, ip_address, user_agent) VALUES (?, ?, TRUE, ?, ?)",
    [user.id, identifier, req.ip ?? null, req.get("user-agent")?.slice(0, 500) ?? null],
  );
  const [rolePermissions] = await pool.execute<Array<RowDataPacket & { module_id: string }>>(
    `SELECT DISTINCT rp.module_id FROM role_permissions rp
     JOIN user_roles ur ON ur.role_id=rp.role_id
     WHERE ur.user_id=? AND rp.allowed=TRUE`,
    [user.id],
  );
  const [userOverrides] = await pool.execute<Array<RowDataPacket & { module_id: string; allowed: number }>>(
    "SELECT module_id, allowed FROM user_permissions WHERE user_id=?",
    [user.id],
  );
  const modules = new Set(rolePermissions.map((row) => row.module_id));
  if (roleNames.includes("admin")) {
    const [allModules] = await pool.execute<Array<RowDataPacket & { id: string }>>("SELECT id FROM modules");
    for (const module of allModules) modules.add(module.id);
  } else {
    for (const override of userOverrides) {
      if (override.allowed) modules.add(override.module_id);
      else modules.delete(override.module_id);
    }
  }
  const moduleIds = [...modules];
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
    sameSite: cookieSameSite,
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
  const [availableModules] = await pool.execute<Array<RowDataPacket & {
    id: string; route: string; sort_order: number;
  }>>("SELECT id, route, sort_order FROM modules ORDER BY sort_order");
  const landingByRole = roleNames.includes("cashier") ? "/pos"
    : roleNames.includes("inventory_manager") ? "/inventory"
      : roleNames.includes("procurement_officer") ? "/purchases"
        : roleNames.includes("accountant") ? "/reports" : "/";
  const defaultLanding = availableModules.find((module) =>
    landingModuleIds.has(module.id) && module.route === user.default_landing && moduleIds.includes(module.id))?.route
    ?? availableModules.find((module) =>
      landingModuleIds.has(module.id) && module.route === landingByRole && moduleIds.includes(module.id))?.route
    ?? availableModules.find((module) => landingModuleIds.has(module.id) && moduleIds.includes(module.id))?.route
    ?? null;
  res.json({
    user: {
      id: user.id, name: user.name, email: user.email, username: user.username,
      branchId: user.branch_id, roles: roleNames, modules: moduleIds,
      defaultLanding, mustChangePassword: Boolean(user.must_change_password),
    },
  });
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
    const [rolePermissions] = await pool.execute<Array<RowDataPacket & { module_id: string }>>(
      `SELECT DISTINCT rp.module_id FROM role_permissions rp
       JOIN user_roles ur ON ur.role_id=rp.role_id
       WHERE ur.user_id=? AND rp.allowed=TRUE`,
      [rows[0].id],
    );
    const [userOverrides] = await pool.execute<Array<RowDataPacket & { module_id: string; allowed: number }>>(
      "SELECT module_id, allowed FROM user_permissions WHERE user_id=?",
      [rows[0].id],
    );
    const modules = new Set(rolePermissions.map((row) => row.module_id));
    const roleNames = roles.map((role) => role.name);
    if (roleNames.includes("admin")) {
      const [allModules] = await pool.execute<Array<RowDataPacket & { id: string }>>("SELECT id FROM modules");
      for (const module of allModules) modules.add(module.id);
    } else {
      for (const override of userOverrides) {
        if (override.allowed) modules.add(override.module_id);
        else modules.delete(override.module_id);
      }
    }
    const [profileRows] = await pool.execute<Array<UserRow & RowDataPacket>>(
      "SELECT username, default_landing, must_change_password, pos_username FROM users WHERE id=? LIMIT 1",
      [rows[0].id],
    );
    const profile = profileRows[0];
    req.user = {
      id: rows[0].id,
      name: rows[0].name,
      email: rows[0].email,
      branchId: rows[0].branch_id,
      roles: roleNames,
      modules: [...modules],
      defaultLanding: profile?.default_landing ?? undefined,
      posUsername: profile?.pos_username ?? undefined,
      mustChangePassword: Boolean(profile?.must_change_password),
    };
    req.sessionId = claims.sid;
    const allowedWhileChangingPassword = new Set([
      "/api/auth/me", "/api/auth/logout", "/api/auth/change-password",
    ]);
    if (req.user.mustChangePassword && !allowedWhileChangingPassword.has(req.originalUrl.split("?")[0] ?? "")) {
      res.status(403).json({ error: "Change your temporary password before continuing.", code: "PASSWORD_CHANGE_REQUIRED" });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const input = changePasswordSchema.parse(req.body);
  const user = req.user;
  if (!user || !req.sessionId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (input.currentPassword === input.newPassword) {
    res.status(400).json({ error: "Choose a new password different from your current password." });
    return;
  }
  const [users] = await pool.execute<Array<RowDataPacket & {
    password_hash: string; pos_password_hash: string | null; must_change_password: number;
  }>>("SELECT password_hash, pos_password_hash, must_change_password FROM users WHERE id=? LIMIT 1", [user.id]);
  if (!users[0] || !(await bcrypt.compare(input.currentPassword, users[0].password_hash))) {
    res.status(400).json({ error: "Current password is incorrect." });
    return;
  }
  const passwordHash = await bcrypt.hash(input.newPassword, 12);
  const sessionId = req.sessionId;
  await withTransaction(async (connection) => {
    await connection.execute(
      `UPDATE users SET password_hash=?,
       pos_password_hash=IF(must_change_password=TRUE OR pos_password_hash IS NULL, ?, pos_password_hash),
       must_change_password=FALSE, main_failed_attempts=0, main_locked_until=NULL WHERE id=?`,
      [passwordHash, passwordHash, user.id],
    );
    await connection.execute("DELETE FROM auth_sessions WHERE user_id=? AND id<>?", [user.id, sessionId]);
    await connection.execute("DELETE FROM pos_sessions WHERE user_id=?", [user.id]);
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'auth.password_changed', 'user', ?)",
      [user.id, String(user.id)],
    );
  });
  user.mustChangePassword = false;
  res.json({ changed: true });
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

export function requireModule(moduleId: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user?.modules?.includes(moduleId)) {
      res.status(403).json({ error: "You do not have permission to access this module." });
      return;
    }
    next();
  };
}

function canUsePos(user: AuthUser): boolean {
  return user.modules?.includes("pos") === true
    && user.roles.some((role) => ["admin", "manager", "cashier"].includes(role));
}

async function createPosSessionForAuthenticatedUser(req: Request, res: Response): Promise<boolean> {
  const user = req.user;
  if (!user || !req.sessionId) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  if (user.mustChangePassword) {
    res.status(403).json({ error: "Change your temporary password before using POS." });
    return false;
  }
  if (!canUsePos(user)) {
    res.status(403).json({ error: "This account is not authorized for POS access." });
    return false;
  }
  const sessions = await query<Array<{ expires_at: Date } & RowDataPacket>>(
    "SELECT expires_at FROM auth_sessions WHERE id = ? AND user_id = ? AND expires_at > NOW() LIMIT 1",
    [req.sessionId, user.id],
  );
  if (!sessions[0]) {
    res.status(401).json({ error: "Session expired. Please sign in again." });
    return false;
  }
  const posSessionId = randomUUID();
  const expiresAt = sessions[0].expires_at;
  await execute("INSERT INTO pos_sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [
    posSessionId, user.id, expiresAt,
  ]);
  await execute(
    "UPDATE users SET last_pos_login_at=CURRENT_TIMESTAMP, last_pos_activity_at=CURRENT_TIMESTAMP WHERE id=?",
    [user.id],
  );
  await execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'pos.login', 'user', ?)",
    [user.id, String(user.id)],
  );
  res.cookie(posSessionCookie, posSessionId, {
    httpOnly: true, sameSite: cookieSameSite, secure: process.env.NODE_ENV === "production",
    expires: expiresAt, path: "/",
  });
  req.posUser = user;
  req.posSessionId = posSessionId;
  return true;
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.sessionId && req.user) {
    await execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'auth.logout', 'user', ?)",
      [req.user.id, String(req.user.id)],
    );
    await execute("DELETE FROM auth_sessions WHERE id = ?", [req.sessionId]);
  }
  res.clearCookie(sessionCookie, { httpOnly: true, sameSite: cookieSameSite, secure: process.env.NODE_ENV === "production", path: "/" });
  res.status(204).end();
}

export function currentUser(req: Request, res: Response): void {
  res.json({ user: req.user });
}

export async function posLogin(req: Request, res: Response): Promise<void> {
  const input = posLoginSchema.parse(req.body);
  const [users] = await pool.execute<Array<UserRow & {
    pos_password_hash: string | null; pos_failed_attempts: number; pos_locked_until: Date | null;
  }>>(
    `SELECT id, name, email, branch_id, password_hash, pos_password_hash, is_active,
            must_change_password, pos_failed_attempts, pos_locked_until
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
  const [rolePermissions] = await pool.execute<Array<RowDataPacket & { module_id: string }>>(
    `SELECT DISTINCT rp.module_id FROM role_permissions rp
     JOIN user_roles ur ON ur.role_id=rp.role_id
     WHERE ur.user_id=? AND rp.allowed=TRUE`,
    [user.id],
  );
  const [userOverrides] = await pool.execute<Array<RowDataPacket & { module_id: string; allowed: number }>>(
    "SELECT module_id, allowed FROM user_permissions WHERE user_id=?",
    [user.id],
  );
  const modules = new Set(rolePermissions.map((row) => row.module_id));
  if (roleNames.includes("admin")) {
    const [allModules] = await pool.execute<Array<RowDataPacket & { id: string }>>("SELECT id FROM modules");
    for (const module of allModules) modules.add(module.id);
  } else {
    for (const override of userOverrides) {
      if (override.allowed) modules.add(override.module_id);
      else modules.delete(override.module_id);
    }
  }
  if (!modules.has("pos")) {
    res.status(403).json({ error: "This account does not have permission to access POS." });
    return;
  }
  const posPasswordHash = user.pos_password_hash ?? user.password_hash;
  if (!(await bcrypt.compare(input.password, posPasswordHash))) {
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
  if (user.must_change_password) {
    res.status(403).json({ error: "Sign in to the staff workspace and change your temporary password before opening POS." });
    return;
  }
  await execute("UPDATE users SET pos_failed_attempts = 0, pos_locked_until = NULL WHERE id = ?", [user.id]);
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  await execute("INSERT INTO pos_sessions (id, user_id, expires_at) VALUES (?, ?, ?)", [sessionId, user.id, expiresAt]);
  await execute(
    "UPDATE users SET last_pos_login_at=CURRENT_TIMESTAMP, last_pos_activity_at=CURRENT_TIMESTAMP WHERE id=?",
    [user.id],
  );
  await execute(
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'pos.login', 'user', ?)",
    [user.id, String(user.id)],
  );
  res.cookie(posSessionCookie, sessionId, {
    httpOnly: true, sameSite: cookieSameSite, secure: process.env.NODE_ENV === "production",
    expires: expiresAt, path: "/",
  });
  res.json({ cashier: { id: user.id, name: user.name, username: input.username.toLowerCase(), branchId: user.branch_id, roles: roleNames } });
}

export async function authenticatePos(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user;
    if (!user || !req.sessionId) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (user.mustChangePassword) {
      res.status(403).json({ error: "Change your temporary password before using POS." });
      return;
    }
    if (!canUsePos(user)) {
      res.status(403).json({ error: "This account is not authorized for POS access." });
      return;
    }

    const sessionId = req.cookies?.[posSessionCookie];
    if (sessionId) {
      const rows = await query<Array<{ user_id: number } & RowDataPacket>>(
        `SELECT s.user_id FROM pos_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND u.is_active = TRUE AND s.expires_at > NOW() LIMIT 1`,
        [sessionId],
      );
      if (rows[0]?.user_id === user.id) {
        req.posUser = user;
        req.posSessionId = sessionId;
        await execute("UPDATE pos_sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [sessionId]);
        next();
        return;
      }
      res.clearCookie(posSessionCookie, {
        httpOnly: true, sameSite: cookieSameSite, secure: process.env.NODE_ENV === "production", path: "/",
      });
    }

    if (!(await createPosSessionForAuthenticatedUser(req, res))) return;
    next();
  } catch (error) {
    next(error);
  }
}

export async function posLogout(req: Request, res: Response): Promise<void> {
  if (req.posUser && req.posSessionId) {
    await revokeScannerPairingsForPosSession(req.posSessionId);
    await execute("UPDATE users SET last_pos_activity_at=CURRENT_TIMESTAMP WHERE id=?", [req.posUser.id]);
    await execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'pos.logout', 'user', ?)",
      [req.posUser.id, String(req.posUser.id)],
    );
    await execute("DELETE FROM pos_sessions WHERE id = ?", [req.posSessionId]);
  }
  res.clearCookie(posSessionCookie, { httpOnly: true, sameSite: cookieSameSite, secure: process.env.NODE_ENV === "production", path: "/" });
  res.status(204).end();
}
