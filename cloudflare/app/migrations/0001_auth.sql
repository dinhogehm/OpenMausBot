-- Better Auth SQLite core + database rate limit schema; exercised through OTP
-- sign-in, session lookup and logout against the pinned version in package.json.
CREATE TABLE "user" (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, "emailVerified" INTEGER NOT NULL, image TEXT, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL);
CREATE TABLE "session" (id TEXT PRIMARY KEY NOT NULL, "expiresAt" DATE NOT NULL, token TEXT NOT NULL UNIQUE, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL, "ipAddress" TEXT, "userAgent" TEXT, "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE);
CREATE TABLE account (id TEXT PRIMARY KEY NOT NULL, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT, "accessTokenExpiresAt" DATE, "refreshTokenExpiresAt" DATE, scope TEXT, password TEXT, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL);
CREATE TABLE verification (id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL, "expiresAt" DATE NOT NULL, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL);
CREATE TABLE "rateLimit" (id TEXT PRIMARY KEY NOT NULL, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, "lastRequest" BIGINT NOT NULL);
CREATE INDEX session_user_idx ON "session"("userId");
CREATE INDEX account_user_idx ON account("userId");
CREATE INDEX verification_identifier_idx ON verification(identifier);
