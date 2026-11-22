// backend/tests/helpers/authHelper.js
import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_at_least_32_characters_long";
process.env.JWT_SECRET = TEST_JWT_SECRET;

export function generateTestToken({
  userId = "test_user_id_123",
  tier = "FREE",
  accessToken = "gho_test_access_token_123",
  expiresIn = "1h"
} = {}) {
  return jwt.sign(
    { userId, tier, accessToken },
    TEST_JWT_SECRET,
    { expiresIn }
  );
}

export function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

export function mockUser({
  id = "test_user_id_123",
  githubId = "12345678",
  name = "Test Octocat",
  email = "octocat@test.local",
  avatarUrl = "https://avatars.githubusercontent.com/u/12345678",
  tier = "FREE"
} = {}) {
  return {
    id,
    githubId,
    name,
    email,
    avatarUrl,
    tier
  };
}
