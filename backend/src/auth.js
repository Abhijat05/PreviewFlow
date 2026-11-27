// backend/src/auth.js
import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";
import { prisma } from "./db.js";
import { encryptSecret } from "./services/cryptoService.js";
import "dotenv/config";

passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID || "ci_mock_github_client_id",
      clientSecret: process.env.GITHUB_CLIENT_SECRET || "ci_mock_github_client_secret",
      callbackURL: process.env.GITHUB_CALLBACK_URL || "http://localhost:4000/auth/github/callback",
      scope: ["read:user", "repo"]
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const existingUser = await prisma.user.findUnique({
          where: { githubId: profile.id }
        });

        const encryptedToken = encryptSecret(accessToken);

        const user = await prisma.user.upsert({
          where: { githubId: profile.id },
          update: {
            name: profile.displayName,
            avatarUrl: profile.photos?.[0]?.value,
            tier: existingUser?.tier,
            ...(encryptedToken ? { accessToken: encryptedToken } : {})
          },
          create: {
            githubId: profile.id,
            name: profile.displayName,
            avatarUrl: profile.photos?.[0]?.value,
            tier: "FREE",
            ...(encryptedToken ? { accessToken: encryptedToken } : {})
          }
        });

        // Keep decrypted token strictly in memory for server-side request lifecycle
        user.accessToken = accessToken;
        user.tier = existingUser?.tier || user.tier;

        return done(null, user);
      } catch (err) {
        console.error("GitHub OAuth Error:", err);
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
});

export default passport;
