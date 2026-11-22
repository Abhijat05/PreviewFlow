// backend/tests/integration/authRoutes.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { generateTestToken } from "../helpers/authHelper.js";

describe("5.1 Authentication API Integration Tests", () => {
  let originalFindUnique;

  beforeEach(() => {
    originalFindUnique = prisma.user.findUnique;
  });

  afterEach(() => {
    prisma.user.findUnique = originalFindUnique;
  });

  test("GET /health responds with 200 and healthy status without auth", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "healthy");
    assert.ok(res.body.timestamp);
  });

  test("GET /api/user/me succeeds with 200 for valid JWT and returns fresh user info", async () => {
    prisma.user.findUnique = async ({ where }) => {
      if (where.id === "user_jwt_valid") {
        return {
          id: "user_jwt_valid",
          githubId: "987654321",
          name: "Octocat Pro",
          username: "octocatpro",
          tier: "PRO"
        };
      }
      return null;
    };

    const token = generateTestToken({ userId: "user_jwt_valid", tier: "FREE" }); // Token says FREE, DB says PRO
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.id, "user_jwt_valid");
    assert.equal(res.body.tier, "PRO", "Fresh database tier must be returned");
  });

  test("GET /api/user/me returns 401 when Authorization header is missing", async () => {
    const res = await request(app).get("/api/user/me");
    assert.equal(res.status, 401);
    assert.match(res.body.error, /missing token/i);
  });

  test("GET /api/user/me returns 401 when Bearer token is malformed", async () => {
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", "Bearer not.a.valid.jwt");

    assert.equal(res.status, 401);
  });

  test("GET /api/user/me returns 401 when JWT is expired", async () => {
    const expiredToken = generateTestToken({
      userId: "user_expired",
      expiresIn: "-1s"
    });

    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${expiredToken}`);

    assert.equal(res.status, 401);
    assert.match(res.body.error, /jwt expired/i);
  });

  test("GET /api/user/me returns 401 when user in JWT does not exist in database", async () => {
    prisma.user.findUnique = async () => null;

    const token = generateTestToken({ userId: "user_non_existent" });
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(res.status, 401);
    assert.match(res.body.error, /user not found/i);
  });

  test("protected routes reject non-Bearer authorization schemes with 401", async () => {
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", "Basic dXNlcjpwYXNz");

    assert.equal(res.status, 401);
  });
});
