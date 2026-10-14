import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";

import type { AppEnv } from "./env";

export function createAuth(env: AppEnv, ctx: ExecutionContext) {
  const origin = new URL(env.APP_ORIGIN);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);

  return betterAuth({
    appName: "Veltram",
    baseURL: origin.origin,
    basePath: "/api/auth",
    secret: env.AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin.origin],
    logger: { disabled: true },
    emailAndPassword: { enabled: false },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 5 },
        "/sign-in/email-otp": { window: 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: origin.protocol === "https:" || !local,
      disableOriginCheck: false,
      disableCSRFCheck: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: { generateId: "uuid" },
      backgroundTasks: { handler: (promise) => { ctx.waitUntil(promise); } },
    },
    plugins: [emailOTP({
      otpLength: 8,
      expiresIn: 600,
      allowedAttempts: 5,
      storeOTP: "hashed",
      resendStrategy: "rotate",
      disableSignUp: false,
      rateLimit: { window: 60, max: 5 },
      async sendVerificationOTP({ email, otp }) {
        try {
          await env.EMAIL.send({
            to: email,
            from: { email: env.EMAIL_FROM, name: "Veltram" },
            subject: "Seu código de acesso ao Veltram",
            text: `Seu código de acesso é ${otp}. Ele expira em 10 minutos. Se você não pediu este código, ignore esta mensagem.`,
            html: `<p>Seu código de acesso é <strong>${otp}</strong>.</p><p>Ele expira em 10 minutos. Se você não pediu este código, ignore esta mensagem.</p>`,
          });
        } catch {
          // Preserve the same public response without logging addresses, codes,
          // provider errors, or any other authentication material.
          console.error(JSON.stringify({ event: "auth_email_delivery_failed" }));
        }
      },
    })],
  });
}
