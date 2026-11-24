import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "./auth.js";

const { executeMock, queryMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock("./db.js", () => ({
  execute: executeMock,
  pool: { execute: vi.fn() },
  query: queryMock,
  withTransaction: vi.fn(),
}));
vi.mock("./mobile-scanner.js", () => ({ revokeScannerPairingsForPosSession: vi.fn() }));

import { authenticatePos } from "./auth.js";

function createRequest(overrides: Partial<Request> = {}): Request {
  const user: AuthUser = {
    id: 8, name: "Casey Cashier", email: "casey@example.test", branchId: 2,
    roles: ["cashier"], modules: ["pos"], posUsername: "casey",
  };
  return {
    user,
    sessionId: "main-session",
    cookies: {},
    ...overrides,
  } as Request;
}

function createResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response;
}

describe("POS session authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a POS session from the validated workspace session", async () => {
    const expiresAt = new Date("2026-11-24T20:00:00.000Z");
    queryMock.mockResolvedValueOnce([{ expires_at: expiresAt }]);
    const req = createRequest();
    const res = createResponse();
    const next = vi.fn() as unknown as NextFunction;

    await authenticatePos(req, res, next);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("FROM auth_sessions"),
      ["main-session", 8],
    );
    expect(executeMock).toHaveBeenCalledWith(
      "INSERT INTO pos_sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
      [expect.any(String), 8, expiresAt],
    );
    expect(res.cookie).toHaveBeenCalledWith("smart_pos_pos_session", expect.any(String), expect.objectContaining({
      httpOnly: true, expires: expiresAt, path: "/",
    }));
    expect(req.posUser?.id).toBe(8);
    expect(next).toHaveBeenCalledOnce();
  });

  it("replaces a POS cookie belonging to another authenticated user", async () => {
    const expiresAt = new Date("2026-11-24T20:00:00.000Z");
    queryMock
      .mockResolvedValueOnce([{ user_id: 99 }])
      .mockResolvedValueOnce([{ expires_at: expiresAt }]);
    const req = createRequest({ cookies: { smart_pos_pos_session: "other-cashier-session" } });
    const res = createResponse();
    const next = vi.fn() as unknown as NextFunction;

    await authenticatePos(req, res, next);

    expect(res.clearCookie).toHaveBeenCalledWith("smart_pos_pos_session", expect.objectContaining({ path: "/" }));
    expect(req.posUser?.id).toBe(8);
    expect(req.posSessionId).not.toBe("other-cashier-session");
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects workspace users without the POS role and module", async () => {
    const req = createRequest({ user: {
      id: 9, name: "Inventory User", email: "inventory@example.test", branchId: 2,
      roles: ["inventory_manager"], modules: ["inventory"],
    } });
    const res = createResponse();
    const next = vi.fn() as unknown as NextFunction;

    await authenticatePos(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(queryMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
