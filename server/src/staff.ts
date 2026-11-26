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
export const manageableModuleIds = new Set([
  "dashboard", "pos", "sales", "products", "inventory", "purchases", "suppliers",
  "customers", "expenses", "shifts", "reports", "permissions",
  "branches", "sync_monitor", "backups", "price_history", "notifications", "receipts", "comparisons",
  "cashier_monitoring",
  "transaction_own", "transaction_all", "transaction_details", "transaction_print",
  "transaction_reprint", "transaction_export", "transaction_cancel", "transaction_refund",
]);
const userGrantedTransactionModuleIds = new Set([
  "sales", "transaction_own", "transaction_all", "transaction_details",
  "transaction_print", "transaction_reprint", "transaction_export",
  "transaction_cancel", "transaction_refund",
]);
export const landingModuleIds = new Set(
  [...manageableModuleIds].filter((moduleId) => !moduleId.startsWith("transaction_")),
);

export const createStaffSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.email().max(254),
  username: z.string().trim().min(4).max(100).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(4).max(200),
  role: z.enum(staffRoles),
  branchId: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
  mustChangePassword: z.boolean().default(true),
  defaultLanding: z.string().trim().min(1).max(160).nullable().optional(),
  employeeNumber: z.string().trim().min(1).max(50).nullable().optional(),
  modulePermissions: z.array(z.object({
    moduleId: z.string().min(1).max(40),
    allowed: z.boolean().nullable(),
  }).strict()).optional(),
  permissions: z.array(z.string().min(1).max(40)).optional(),
  departmentId: z.number().int().positive().nullable().optional(),
  jobTitle: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  hiredAt: z.iso.date().nullable().optional(),
}).strict();

export const staffStatusSchema = z.object({ isActive: z.boolean() }).strict();
export const updateStaffSchema = createStaffSchema.omit({ password: true, mustChangePassword: true }).partial().extend({
  modulePermissions: createStaffSchema.shape.modulePermissions,
}).strict();
export const resetStaffPasswordSchema = z.object({
  password: z.string().min(4).max(200),
}).strict();
export const modulePermissionsSchema = z.array(z.object({
  moduleId: z.string().min(1).max(40),
  allowed: z.boolean(),
}).strict()).max(100).superRefine((permissions, context) => {
  if (new Set(permissions.map(({ moduleId }) => moduleId)).size !== permissions.length) {
    context.addIssue({ code: "custom", message: "Each module can be configured only once." });
  }
});
export const modulePermissionOverridesSchema = z.array(z.object({
  moduleId: z.string().min(1).max(40),
  allowed: z.boolean().nullable(),
}).strict()).max(100).superRefine((permissions, context) => {
  if (new Set(permissions.map(({ moduleId }) => moduleId)).size !== permissions.length) {
    context.addIssue({ code: "custom", message: "Each module can be configured only once." });
  }
});

export function canAssignStaffRole(actor: AuthUser, role: (typeof staffRoles)[number]): boolean {
  return actor.roles.includes("admin") && staffRoles.includes(role);
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
    branch_id: number;
    branch_name: string;
    employee_number: string | null;
    default_landing: string | null;
    permission_overrides: string;
  } & RowDataPacket>>(
    `SELECT u.id, u.name, u.email, u.username, u.branch_id, b.name AS branch_name,
            u.default_landing, u.is_active, u.created_at, d.name AS department, e.employee_number,
            e.job_title, e.phone, e.hired_at,
            COALESCE(GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ','), '') AS roles,
            COALESCE(GROUP_CONCAT(DISTINCT CONCAT(up.module_id, ':', up.allowed) SEPARATOR ','), '') AS permission_overrides,
            (SELECT MAX(a.created_at) FROM audit_logs a
             WHERE a.user_id = u.id AND a.action = 'auth.login') AS last_login
     FROM users u
     JOIN branches b ON b.id = u.branch_id
     LEFT JOIN employees e ON e.user_id = u.id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     LEFT JOIN user_permissions up ON up.user_id = u.id
     WHERE u.branch_id = ? AND (? = '' OR u.name LIKE CONCAT('%', ?, '%') OR u.email LIKE CONCAT('%', ?, '%') OR u.username LIKE CONCAT('%', ?, '%') OR e.employee_number LIKE CONCAT('%', ?, '%'))
     GROUP BY u.id, u.name, u.email, u.username, u.branch_id, b.name, u.default_landing, u.is_active, u.created_at,
              d.name, e.employee_number, e.job_title, e.phone, e.hired_at
     ORDER BY u.name LIMIT 250`,
    [branchId, search, search, search, search, search],
  );
}

export async function listDepartments() {
  return query<Array<{ id: number; name: string } & RowDataPacket>>(
    "SELECT id, name FROM departments ORDER BY name",
  );
}

async function ensureLandingAllowed(
  connection: import("mysql2/promise").PoolConnection,
  userId: number,
  landing: string | null,
): Promise<void> {
  if (!landing) return;
  if (landing === "/staff" || landing === "/settings/user-management") {
    const [admins] = await connection.execute<Array<RowDataPacket & { is_admin: number }>>(
      `SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
                      WHERE ur.user_id=? AND r.name='admin') AS is_admin`,
      [userId],
    );
    if (!admins[0]?.is_admin) throw new HttpError(400, "User management cannot be a default landing page.");
  }
  const [modules] = await connection.execute<Array<RowDataPacket & { allowed: number }>>(
    `SELECT m.id, COALESCE(up.allowed, MAX(rp.allowed), FALSE) AS allowed
     FROM modules m
     LEFT JOIN user_permissions up ON up.user_id=? AND up.module_id=m.id
     LEFT JOIN user_roles ur ON ur.user_id=?
     LEFT JOIN role_permissions rp ON rp.role_id=ur.role_id AND rp.module_id=m.id
     WHERE m.route=? AND m.id IN (${[...landingModuleIds].map(() => "?").join(",")})
     GROUP BY m.id, up.allowed`,
    [userId, userId, landing, ...landingModuleIds],
  );
  if (!modules.some((module) => Boolean(module.allowed))) {
    throw new HttpError(400, "The default landing page must be enabled for this user.");
  }
}

async function validateModuleIds(
  connection: import("mysql2/promise").PoolConnection,
  permissions: Array<{ moduleId: string; allowed: boolean | null }>,
): Promise<void> {
  if (new Set(permissions.map(({ moduleId }) => moduleId)).size !== permissions.length) {
    throw new HttpError(400, "Each module can be configured only once.");
  }
  if (permissions.some(({ moduleId }) => !manageableModuleIds.has(moduleId))) {
    throw new HttpError(400, "One or more selected permission modules are unavailable.");
  }
  if (!permissions.length) return;
  const [modules] = await connection.execute<Array<RowDataPacket & { id: string }>>(
    `SELECT id FROM modules WHERE id IN (${permissions.map(() => "?").join(",")})`,
    permissions.map(({ moduleId }) => moduleId),
  );
  if (modules.length !== permissions.length) {
    throw new HttpError(400, "One or more selected permission modules are invalid.");
  }
}

export async function createStaff(input: z.infer<typeof createStaffSchema>, actor: AuthUser) {
  if (!canAssignStaffRole(actor, input.role)) {
    throw new HttpError(403, "You cannot assign this role.");
  }
  const passwordHash = await bcrypt.hash(input.password, 12);
  return withTransaction(async (connection) => {
    const branchId = input.branchId ?? actor.branchId;
    const [branches] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM branches WHERE id=?",
      [branchId],
    );
    if (!branches[0]) throw new HttpError(404, "Branch not found.");
    if (input.departmentId !== undefined && input.departmentId !== null) {
      const [departments] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM departments WHERE id = ?",
        [input.departmentId],
      );
      if (!departments[0]) throw new HttpError(404, "Department not found.");
    }

    try {
      const [result] = await connection.execute(
        `INSERT INTO users (branch_id, name, email, username, pos_username, password_hash, pos_password_hash,
                            default_landing, must_change_password, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          branchId, input.name, input.email.trim().toLowerCase(),
          input.username.trim().toLowerCase(),
          input.username.trim().toLowerCase(),
          passwordHash, passwordHash,
          input.defaultLanding ?? null, input.mustChangePassword, input.isActive ?? true,
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
      const permissions = input.modulePermissions
        ?? input.permissions?.map((moduleId) => ({ moduleId, allowed: true }));
      if (permissions) {
        await validateModuleIds(connection, permissions);
        for (const permission of permissions) {
          if (permission.allowed !== null) {
            await connection.execute(
              "INSERT INTO user_permissions (user_id, module_id, allowed) VALUES (?, ?, ?)",
              [userId, permission.moduleId, permission.allowed],
            );
          }
        }
      }
      await connection.execute(
        `INSERT INTO employees (user_id, department_id, employee_number, job_title, phone, hired_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, input.departmentId ?? null, input.employeeNumber?.trim() || null, input.jobTitle || null, input.phone || null, input.hiredAt ?? null],
      );
      await ensureLandingAllowed(connection, userId, input.defaultLanding ?? null);
      await connection.execute(
        "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'staff.created', 'user', ?, ?)",
        [actor.id, String(userId), JSON.stringify({ role: input.role, departmentId: input.departmentId ?? null })],
      );
      return { id: userId, name: input.name, email: input.email.trim().toLowerCase(), role: input.role };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
        throw new HttpError(409, "The email, username, POS username, or employee number is already in use.");
      }
      throw error;
    }
  });
}

export async function updateStaff(
  userId: number,
  input: z.infer<typeof updateStaffSchema>,
  actor: AuthUser,
) {
  return withTransaction(async (connection) => {
    const [existing] = await connection.execute<Array<RowDataPacket & {
      id: number; branch_id: number; is_active: number; has_admin: number; default_landing: string | null;
    }>>(
      `SELECT u.id, u.branch_id, u.is_active, u.default_landing,
              EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
                      WHERE ur.user_id=u.id AND r.name='admin') AS has_admin
       FROM users u WHERE u.id=? FOR UPDATE`,
      [userId],
    );
    const user = existing[0];
    if (!user) throw new HttpError(404, "Staff account not found.");
    if (input.role && !canAssignStaffRole(actor, input.role)) throw new HttpError(403, "You cannot assign this role.");
    if (userId === actor.id && input.role && input.role !== "admin") {
      throw new HttpError(409, "You cannot remove your own administrator role.");
    }
    if (userId === actor.id && input.isActive === false) {
      throw new HttpError(409, "You cannot deactivate your own account.");
    }

    const nextBranchId = input.branchId ?? user.branch_id;
    if (input.branchId !== undefined) {
      const [branches] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM branches WHERE id=?",
        [input.branchId],
      );
      if (!branches[0]) throw new HttpError(404, "Branch not found.");
    }
    if (input.departmentId) {
      const [departments] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM departments WHERE id=?",
        [input.departmentId],
      );
      if (!departments[0]) throw new HttpError(404, "Department not found.");
    }

    const removesAdmin = Boolean(user.has_admin) && (
      input.role !== undefined && input.role !== "admin"
      || input.isActive === false
      || nextBranchId !== user.branch_id
    );
    if (removesAdmin && user.is_active) {
      const [admins] = await connection.execute<Array<RowDataPacket & { count: number }>>(
        `SELECT COUNT(*) AS count FROM users u
         JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
         WHERE u.branch_id=? AND u.is_active=TRUE AND r.name='admin'`,
        [user.branch_id],
      );
      if (Number(admins[0]?.count ?? 0) <= 1) {
        throw new HttpError(409, "The branch must retain at least one active administrator.");
      }
    }

    const userUpdates: Array<[string, string | number | boolean | null]> = [];
    if (input.name !== undefined) userUpdates.push(["name", input.name]);
    if (input.email !== undefined) userUpdates.push(["email", input.email.trim().toLowerCase()]);
    if (input.username !== undefined) {
      const username = input.username.trim().toLowerCase();
      userUpdates.push(["username", username], ["pos_username", username]);
    }
    if (input.defaultLanding !== undefined) userUpdates.push(["default_landing", input.defaultLanding]);
    if (input.isActive !== undefined) userUpdates.push(["is_active", input.isActive]);
    if (input.branchId !== undefined) userUpdates.push(["branch_id", nextBranchId]);
    if (userUpdates.length) {
      const assignments = userUpdates.map(([field]) => `${field}=?`).join(", ");
      await connection.execute(
        `UPDATE users SET ${assignments} WHERE id=?`,
        [...userUpdates.map(([, value]) => value), userId],
      );
    }

    if (input.role !== undefined) {
      const [roles] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        "SELECT id FROM roles WHERE name=? LIMIT 1",
        [input.role],
      );
      if (!roles[0]) throw new Error(`Required role ${input.role} is missing from the database.`);
      await connection.execute("DELETE FROM user_roles WHERE user_id=?", [userId]);
      await connection.execute("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, roles[0].id]);
    }

    if (input.departmentId !== undefined || input.employeeNumber !== undefined
      || input.jobTitle !== undefined || input.phone !== undefined || input.hiredAt !== undefined) {
      const [employeeRows] = await connection.execute<Array<RowDataPacket & {
        department_id: number | null; employee_number: string | null; job_title: string | null;
        phone: string | null; hired_at: string | null;
      }>>(
        "SELECT department_id, employee_number, job_title, phone, hired_at FROM employees WHERE user_id=?",
        [userId],
      );
      const currentEmployee = employeeRows[0];
      await connection.execute(
        `INSERT INTO employees (user_id, department_id, employee_number, job_title, phone, hired_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE department_id=VALUES(department_id), employee_number=VALUES(employee_number),
                                 job_title=VALUES(job_title), phone=VALUES(phone), hired_at=VALUES(hired_at)`,
        [
          userId,
          input.departmentId !== undefined ? input.departmentId : currentEmployee?.department_id ?? null,
          input.employeeNumber !== undefined ? input.employeeNumber : currentEmployee?.employee_number ?? null,
          input.jobTitle !== undefined ? input.jobTitle : currentEmployee?.job_title ?? null,
          input.phone !== undefined ? input.phone : currentEmployee?.phone ?? null,
          input.hiredAt !== undefined ? input.hiredAt : currentEmployee?.hired_at ?? null,
        ],
      );
    }

    const permissions = input.modulePermissions
      ?? input.permissions?.map((moduleId) => ({ moduleId, allowed: true }));
    if (permissions !== undefined) {
      const targetIsAdmin = input.role === "admin" || (input.role === undefined && Boolean(user.has_admin));
      if (targetIsAdmin && permissions.some(({ allowed }) => allowed !== null)) {
        throw new HttpError(409, "Administrator module access is controlled by the locked role defaults.");
      }
      await validateModuleIds(connection, permissions);
      await connection.execute("DELETE FROM user_permissions WHERE user_id=?", [userId]);
      for (const permission of permissions) {
        if (permission.allowed !== null) {
          await connection.execute(
            "INSERT INTO user_permissions (user_id,module_id,allowed) VALUES (?,?,?)",
            [userId, permission.moduleId, permission.allowed],
          );
        }
      }
    }
    await ensureLandingAllowed(
      connection,
      userId,
      input.defaultLanding !== undefined ? input.defaultLanding : user.default_landing,
    );
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'staff.updated', 'user', ?, ?)",
      [actor.id, String(userId), JSON.stringify({ ...input, password: undefined })],
    );
    if (input.isActive === false) {
      await connection.execute("DELETE FROM auth_sessions WHERE user_id=?", [userId]);
      await connection.execute("DELETE FROM pos_sessions WHERE user_id=?", [userId]);
    }
    return { id: userId, updated: true };
  }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "The email, username, or employee number is already in use.");
    }
    throw error;
  });
}

export async function resetStaffPassword(userId: number, password: string, actor: AuthUser) {
  const passwordHash = await bcrypt.hash(password, 12);
  return withTransaction(async (connection) => {
    const [users] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM users WHERE id=? LIMIT 1 FOR UPDATE",
      [userId],
    );
    if (!users[0]) throw new HttpError(404, "Staff account not found.");
    await connection.execute(
      "UPDATE users SET password_hash=?, pos_password_hash=?, must_change_password=TRUE, main_failed_attempts=0, main_locked_until=NULL WHERE id=?",
      [passwordHash, passwordHash, userId],
    );
    await connection.execute("DELETE FROM auth_sessions WHERE user_id=?", [userId]);
    await connection.execute("DELETE FROM pos_sessions WHERE user_id=?", [userId]);
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES (?, 'staff.password_reset', 'user', ?)",
      [actor.id, String(userId)],
    );
    return { id: userId, passwordReset: true };
  });
}

export async function listStaffActivity(userId: number) {
  const [logins, activity] = await Promise.all([
    query<Array<RowDataPacket & {
      success: number; identifier: string | null; ip_address: string | null; user_agent: string | null; created_at: Date;
    }>>(
      `SELECT h.success, h.identifier, h.ip_address, h.user_agent, h.created_at
       FROM login_history h JOIN users u ON u.id=h.user_id
       WHERE h.user_id=? ORDER BY h.created_at DESC LIMIT 100`,
      [userId],
    ),
    query<Array<RowDataPacket & { action: string; entity_type: string | null; entity_id: string | null; details: string | null; created_at: Date }>>(
      `SELECT a.action, a.entity_type, a.entity_id, a.details, a.created_at
       FROM audit_logs a JOIN users u ON u.id=a.user_id
       WHERE a.user_id=? ORDER BY a.created_at DESC LIMIT 100`,
      [userId],
    ),
  ]);
  return {
    logins: logins.map((row) => ({
      success: Boolean(row.success), identifier: row.identifier, ipAddress: row.ip_address,
      userAgent: row.user_agent, createdAt: row.created_at.toISOString(),
    })),
    activity: activity.map((row) => ({
      action: row.action, entityType: row.entity_type, entityId: row.entity_id,
      details: row.details, createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function listBranches() {
  return query<Array<RowDataPacket & { id: number; name: string; code: string }>>(
    "SELECT id, name, code FROM branches ORDER BY name",
  );
}

export async function listRolePermissions() {
  const [roles, modules, permissions] = await Promise.all([
    query<Array<RowDataPacket & { id: number; name: string }>>("SELECT id, name FROM roles ORDER BY name"),
    query<Array<RowDataPacket & { id: string; name: string; route: string; sort_order: number }>>(
      `SELECT id, name, route, sort_order FROM modules
       WHERE id IN (${[...manageableModuleIds].map(() => "?").join(",")}) ORDER BY sort_order`,
      [...manageableModuleIds],
    ),
    query<Array<RowDataPacket & { role_id: number; module_id: string; allowed: number }>>(
      "SELECT role_id, module_id, allowed FROM role_permissions",
    ),
  ]);
  return roles.map((role) => ({
    id: role.id, name: role.name,
    permissions: modules.map((module) => ({
      moduleId: module.id, name: module.name, route: module.route,
      allowed: Boolean(permissions.find((permission) =>
        permission.role_id === role.id && permission.module_id === module.id)?.allowed),
    })),
  }));
}

export async function updateRolePermissions(
  roleName: string,
  permissions: Array<{ moduleId: string; allowed: boolean }>,
  actor: AuthUser,
) {
  if (!staffRoles.includes(roleName as (typeof staffRoles)[number])) throw new HttpError(404, "Role not found.");
  if (roleName === "admin") throw new HttpError(409, "Administrator access cannot be reduced here.");
  if (permissions.some(({ moduleId, allowed }) => allowed && userGrantedTransactionModuleIds.has(moduleId))) {
    throw new HttpError(409, "Transaction History permissions must be granted to individual users.");
  }
  return withTransaction(async (connection) => {
    await validateModuleIds(connection, permissions);
    const [roles] = await connection.execute<Array<RowDataPacket & { id: number }>>(
      "SELECT id FROM roles WHERE name=? LIMIT 1 FOR UPDATE",
      [roleName],
    );
    if (!roles[0]) throw new HttpError(404, "Role not found.");
    await connection.execute("DELETE FROM role_permissions WHERE role_id=?", [roles[0].id]);
    for (const permission of permissions.filter(({ allowed }) => allowed)) {
      await connection.execute(
        "INSERT INTO role_permissions (role_id,module_id,allowed) VALUES (?,?,TRUE)",
        [roles[0].id, permission.moduleId],
      );
    }
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, 'role.permissions_updated', 'role', ?, ?)",
      [actor.id, roleName, JSON.stringify(permissions)],
    );
    return { role: roleName, updated: true };
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
    const [existingUsers] = await connection.execute<Array<RowDataPacket & { id: number; branch_id: number }>>(
      "SELECT id, branch_id FROM users WHERE id = ? FOR UPDATE",
      [userId],
    );
    const target = existingUsers[0];
    if (!target) throw new HttpError(404, "Staff account not found.");

    if (!isActive) {
      const [admins] = await connection.execute<Array<RowDataPacket & { id: number }>>(
        `SELECT u.id FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         WHERE u.branch_id = ? AND u.is_active = TRUE AND r.name = 'admin'
         FOR UPDATE`,
        [target.branch_id],
      );
      const [targetRoles] = await connection.execute<Array<RowDataPacket & { name: string }>>(
        `SELECT r.name FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         WHERE u.id = ? FOR UPDATE`,
        [userId],
      );
      if (!targetRoles.length) throw new HttpError(404, "Staff account not found.");
      if (targetRoles.some((role) => role.name === "admin") && admins.length <= 1) {
        throw new HttpError(409, "The branch must retain at least one active administrator.");
      }
    }

    await connection.execute(
      "UPDATE users SET is_active = ? WHERE id = ?",
      [isActive, userId],
    );
    if (!isActive) {
      await connection.execute("DELETE FROM auth_sessions WHERE user_id = ?", [userId]);
      await connection.execute("DELETE FROM pos_sessions WHERE user_id = ?", [userId]);
    }
    await connection.execute(
      "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, 'user', ?, ?)",
      [actor.id, isActive ? "staff.activated" : "staff.deactivated", String(userId), JSON.stringify({ isActive })],
    );
    return { id: userId, isActive };
  });
}
