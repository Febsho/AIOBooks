import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { verify } from "@node-rs/argon2";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Database } from "./database.js";

const SESSION_COOKIE = "aiobooks_session";
const CSRF_COOKIE = "aiobooks_csrf";
const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$oHTE1wNtCXNWE7lwpsUexQ$c6/ukwA0d9vFOuv8mapFTyKGJKbWxJC9qNdhXn8JqyQ";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: "ADMIN" | "USER";
}

declare module "fastify" {
  interface FastifyRequest { authUser?: AuthUser; sessionId?: string; }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function cookieOptions(config: AppConfig, httpOnly: boolean) {
  return { path: "/", httpOnly, secure: config.NODE_ENV === "production", sameSite: "lax" as const };
}

export function createAuthGuards(sql: Database) {
  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const rows = await sql<{
      session_id: string; user_id: string; email: string; display_name: string; role: "ADMIN" | "USER";
    }[]>`
      SELECT s.id AS session_id, u.id AS user_id, u.email, u.display_name, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${digest(token)} AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
      LIMIT 1
    `;
    const session = rows[0];
    if (!session) return reply.code(401).send({ error: "INVALID_SESSION" });
    request.sessionId = session.session_id;
    request.authUser = { id: session.user_id, email: session.email, displayName: session.display_name, role: session.role };
  };

  const requireCsrf = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers["x-csrf-token"];
    const cookieValue = request.cookies[CSRF_COOKIE];
    if (typeof header !== "string" || !cookieValue || header !== cookieValue || !request.sessionId) return reply.code(403).send({ error: "INVALID_CSRF_TOKEN" });
    const rows = await sql<{ csrf_secret_hash: Buffer }[]>`SELECT csrf_secret_hash FROM sessions WHERE id = ${request.sessionId} AND revoked_at IS NULL`;
    const expected = rows[0]?.csrf_secret_hash;
    const actual = digest(header);
    if (!expected || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return reply.code(403).send({ error: "INVALID_CSRF_TOKEN" });
  };
  return { requireAuth, requireCsrf };
}

export async function registerAuth(app: FastifyInstance, sql: Database, config: AppConfig) {
  await app.register(cookie);
  const guards = createAuthGuards(sql);
  const loginSchema = z.object({ email: z.string().email().transform((value) => value.toLocaleLowerCase("en")), password: z.string().min(1).max(1024) });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = loginSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "INVALID_CREDENTIALS" });
    const users = await sql<{ id: string; email: string; display_name: string; role: "ADMIN" | "USER"; password_hash: string }[]>`
      SELECT id, email, display_name, role, password_hash FROM users
      WHERE email = ${input.data.email} AND disabled_at IS NULL LIMIT 1
    `;
    const user = users[0];
    const passwordValid = await verify(user?.password_hash ?? DUMMY_PASSWORD_HASH, input.data.password);
    if (!user || !passwordValid) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });

    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000);
    await sql`
      INSERT INTO sessions (user_id, token_hash, csrf_secret_hash, expires_at, user_agent, ip_address)
      VALUES (${user.id}, ${digest(sessionToken)}, ${digest(csrfToken)}, ${expiresAt}, ${request.headers["user-agent"] ?? null}, ${request.ip})
    `;
    reply.setCookie(SESSION_COOKIE, sessionToken, { ...cookieOptions(config, true), expires: expiresAt });
    reply.setCookie(CSRF_COOKIE, csrfToken, { ...cookieOptions(config, false), expires: expiresAt });
    return { user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role }, csrfToken };
  });

  app.get("/api/auth/me", { preHandler: guards.requireAuth }, async (request) => ({ user: request.authUser }));
  app.post("/api/auth/logout", { preHandler: [guards.requireAuth, guards.requireCsrf] }, async (request, reply) => {
    await sql`UPDATE sessions SET revoked_at = now() WHERE id = ${request.sessionId!}`;
    reply.clearCookie(SESSION_COOKIE, cookieOptions(config, true));
    reply.clearCookie(CSRF_COOKIE, cookieOptions(config, false));
    return reply.code(204).send();
  });
  return guards;
}
