import bcrypt from "bcryptjs";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import type { AuthUser } from "./auth.js";
import { query, withTransaction } from "./db.js";
import { HttpError } from "./errors.js";

export const staffRoles = [
  "admin",
  "manager",
  "cashier",
  "inventory_manager",
  "procurement_officer",
  "accountant",
] as const;

export const createStaffSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.email().max(254),
  username: z.string().trim().min(4).max(100).regex(/^[A-Za-z0-9._-]+$/).optional(),
  password: z.string().min(12).max(200),
  role: z.enum(staffRoles),
  defaultLanding: z.string().trim().min(1).max(80).optional(),
  permissions: z.array(z.string().min(1).max(40)).optional(),
  departmentId: z.number().int().positive().nullable().optional(),
  jobTitle: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  hiredAt: z.iso.date().nullable().optional(),
}).strict();

export const staffStatusSchema = z.object({ isActive: z.boolean() }).strict();

export function canAssignStaffRole(actor: AuthUser, role: (typeof staffRoles)[number]): boolean {
  if (role === "admin") return actor.roles.includes("admin");
  if (role === "manager") return actor.roles.includes("admin");
  return actor.roles.includes("admin") || actor.roles.includes("manager");
}

export async function listStaff(branchId: number, search: string) {
  return query<Array<{
    id: number;
    name: string;
    email: string;
    is_active: number;
    created_at: Date;
    department: string | null;
    job_title: string | null;
    phone: string | null;
    hired_at: Date | null;
    roles: string;
    last_login: Date | null;
    username: string | null;
    default_landing: string | null;
    permissions: string;
  } & RowDataPacket>>(
    `SELECT u.id, u.name, u.email, u.username, u.default_landing, u.is_active, u.created_at, d.name AS department,
            e.job_title, e.phone, e.hired_at,
            COALESCE(GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ','), '') AS roles,
            COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN up.allowed=TRUE THEN up.module_id END SEPARATOR ','), '') AS permissions,
            (SELECT MAX(a.created_at) FROM audit_logs a
             WHERE a.user_id = u.id AND a.action = 'auth.login') AS last_login
     FROM users u
     LEFT JOIN employees e ON e.user_id = u.id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     LEFT JOIN user_permissions up ON up.user_id = u.id
     WHERE u.branch_id = ? AND (? = '' OR u.name LIKE CONCAT('%', ?, '%') OR u.email LIKE CONCAT('%', ?, '%'))
     GROUP BY u.id, u.name, u.email, u.username, u.default_landing, u.is_active, u.created_at, d.name, e.job_title, e.phone, e.hired_at
     ORDER BY u.name LIMIT 250`,
    [branchId, search, search, search],
  );
}

export async function listDepartments() {
  return query<Array<{ id: number; name: string } & RowDataPacket>>(
    "SELECT id, name FROM departments ORDER BY name",
  );
}

export async function createStaff(input: z.infer<typeof createStaffSchema>, actor: AuthUser) {
  if (!canAssignStaffRole(actor, input.role)) {
    throw new HttpError(403, "You cannot assign this role.");
  }
  const passwordHash = await bcrypt.hash(input.password, 12);
  return withTransaction(async (connection) => {
    if (input.departmentId !== undefined && input.departmentId !== null) {
      const [departments] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM departments WHERE id = ?",
        [input.departmentId],
      );
      if (!departments[0]) throw new HttpError(404, "Department not found.");
    }

    try {
      const [result] = await connection.execute(
        `INSERT INTO users (branch_id, name, email, username, pos_username, password_hash, pos_password_hash, default_landing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          actor.branchId, input.name, input.email.trim().toLowerCase(),
          input.username?.trim().toLowerCase() ?? null,
          input.username?.trim().toLowerCase() ?? null,
          passwordHash, passwordHash,
          input.defaultLanding ?? null,
        ],
      );
      const userId = (result as { insertId: number }).insertId;
      const [roles] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM roles WHERE name = ?",
        [input.role],
      );
      if (!roles[0]) throw new Error(`Required role ${input.role} is missing from the database.`);
      await connection.execute(
        "INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)",
        [userId, roles[0].id],
      );
      if (input.permissions?.length) {
        const [modules] = await connection.execute<Array<RowDataPacket & { id: string }>>(
          `SELECT id FROM modules WHERE id IN (${input.permissions.map(() => "?").join(",")})`,
          input.permissions,
        );
        for (const module of modules) {
          await connection.execute(
            "INSERT INTO user_permissions (user_id, module_id, allowed) VALUES (?, ?, TRUE)",
            [userId, module.id],
          );
        }
      }
      await connection.execute(
        `INSERT INTO employees (user_id, department_id, job_title, phone, hired_at)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, input.departmentId ?? null, input.jobTitle || null, input.phone || null, input.hiredAt ?? null],
      );
      await connection.execute(
        "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'staff.created', 'user', ?, ?)",
        [actor.id, String(userId), JSON.stringify({ role: input.role, departmentId: input.departmentId ?? null })],
      );
      return { id: userId, name: input.name, email: input.email.trim().toLowerCase(), role: input.role };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
        throw new HttpError(409, "A user with this email already exists.");
      }
      throw error;
    }
  });
}

export async function setStaffStatus(
  userId: number,
  isActive: boolean,
  actor: AuthUser,
) {
  if (userId === actor.id && !isActive) {
    throw new HttpError(409, "You cannot deactivate your own account.");
  }

  return withTransaction(async (connection) => {
    const [existingUsers] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM users WHERE id = ? AND branch_id = ? FOR UPDATE",
      [userId, actor.branchId],
    );
    if (!existingUsers[0]) throw new HttpError(404, "Staff account not found.");

    if (!isActive) {
      const [admins] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        `SELECT u.id FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         WHERE u.branch_id = ? AND u.is_active = TRUE AND r.name = 'admin'
         FOR UPDATE`,
        [actor.branchId],
      );
      const [targetRoles] = await connection.execute<Array<RowDataPacket & { name: string }>>(
        `SELECT r.name FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         WHERE u.id = ? AND u.branch_id = ? FOR UPDATE`,
        [userId, actor.branchId],
      );
      if (!targetRoles.length) throw new HttpError(404, "Staff account not found.");
      if (targetRoles.some((role) => role.name === "admin") && admins.length <= 1) {
        throw new HttpError(409, "The branch must retain at least one active administrator.");
      }
    }

    await connection.execute(
      "UPDATE users SET is_active = ? WHERE id = ? AND branch_id = ?",
      [isActive, userId, actor.branchId],
    );
    if (!isActive) await connection.execute("DELETE FROM auth_sessions WHERE user_id = ?", [userId]);
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, 'user', ?, ?)",
      [actor.id, isActive ? "staff.activated" : "staff.deactivated", String(userId), JSON.stringify({ isActive })],
    );
    return { id: userId, isActive };
  });
}
