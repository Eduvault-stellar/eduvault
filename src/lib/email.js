import nodemailer from "nodemailer";
import { createCircuitBreaker, CircuitState, DependencyError } from "@/lib/resilience/index.js";
import { withTimeout } from "@/lib/resilience/timeout.js";
import { withRetry } from "@/lib/resilience/retry.js";
import { setGauge, incrementCounter } from "@/lib/telemetry/metrics";
import { currentTraceparent } from "@/lib/telemetry/context";

const EMAIL_TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS || 15000);

const emailCircuitBreaker = createCircuitBreaker("email", {
  failureThreshold: Number(process.env.EMAIL_CB_FAILURE_THRESHOLD || 3),
  successThreshold: 2,
  resetTimeoutMs: Number(process.env.EMAIL_CB_RESET_TIMEOUT_MS || 30000),
  onStateChange(name, from, to) {
    setGauge("circuit_breaker_state", { dependency: name, state: to }, 1);
    if (from && from !== to) {
      setGauge("circuit_breaker_state", { dependency: name, state: from }, 0);
    }
    if (to === CircuitState.OPEN) {
      incrementCounter("circuit_breaker_open_total", { dependency: name });
    }
    const level = to === CircuitState.OPEN ? "warn" : "info";
    console[level](`[circuit-breaker] email: ${from} -> ${to}`);
  },
});

export function getEmailCircuitBreakerState() {
  return emailCircuitBreaker.getState();
}

async function withEmailResilience(action, fn, opts = {}) {
  if (emailCircuitBreaker.getState() === CircuitState.OPEN) {
    incrementCounter("rpc_errors_total", { operation: `email.${action}` });
    throw new DependencyError({
      dependency: "email",
      action,
      retryable: false,
      statusCode: 503,
      userMessage: "Email service is temporarily unavailable.",
    });
  }
  return emailCircuitBreaker.call(async () => {
    return withRetry(
      async () => withTimeout(fn(), EMAIL_TIMEOUT_MS, `email.${action}`),
      {
        idempotent: opts.idempotent !== false,
        maxAttempts: Number(process.env.EMAIL_RETRIES || 2),
        baseDelayMs: 500,
        maxDelayMs: 5000,
      }
    );
  });
}

function createTransporter() {
  // Prefer explicit SMTP settings; fallback to Gmail using EMAIL_USER/PASS
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 0);
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (smtpHost) {
    const port = smtpPort || 587;
    return nodemailer.createTransport({
      host: smtpHost,
      port,
      secure: port === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });
  }

  if (!smtpUser || !smtpPass) {
    throw new Error("Email credentials missing (EMAIL_USER/EMAIL_PASS or SMTP_*)");
  }

  // Gmail default
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });
}

export async function sendWelcomeEmail(to, name) {
  const defaultFrom = process.env.EMAIL_USER || "no-reply@eduvault.local";
  const from = process.env.EMAIL_FROM || defaultFrom;
  const transporter = createTransporter();

  const subject = `Welcome to EduVault, ${name}!`;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const dashboardUrl = `${appUrl}/dashboard`;

  const text = `Hi ${name},\n\nWelcome to EduVault! Your student profile has been created.\n\nHead to your dashboard to start exploring, upload study materials, and share to earn.\n\nDashboard: ${dashboardUrl}\n\nCheers,\nEduVault Team`;

  const html = `
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Welcome to EduVault</title>
      <style>
        /* Email-safe inline styles are applied via attributes; minimal resets here */
        @media (prefers-color-scheme: dark) {
          .card { background: #111827 !important; color: #e5e7eb !important; }
          .muted { color: #9ca3af !important; }
          .btn { background: #2563eb !important; }
        }
      </style>
    </head>
    <body style="margin:0;padding:0;background:#f6f9fc;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f9fc;">
        <tr>
          <td align="center" style="padding:24px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;">
              <tr>
                <td style="padding:0 0 12px 0;" align="center">
                  <a href="${appUrl}" style="text-decoration:none;display:inline-flex;align-items:center;gap:8px;color:#111827;">
                    <img src="${appUrl}/images/stellar.png" width="36" height="36" alt="EduVault" style="border:0;display:block;" />
                    <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';font-weight:700;font-size:18px;">EduVault</span>
                  </a>
                </td>
              </tr>
              <tr>
                <td class="card" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                      <td style="padding:24px 24px 8px 24px;">
                        <h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.3;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          Welcome to EduVault, ${name}!
                        </h1>
                        <p class="muted" style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          Your student profile is ready. Explore your dashboard to discover resources, upload materials, and start sharing to earn.
                        </p>
                        <div style="margin:20px 0;">
                          <a class="btn" href="${dashboardUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:8px;font-weight:600;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                            Go to your dashboard
                          </a>
                        </div>
                        <p style="margin:0 0 8px 0;font-size:14px;line-height:1.6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          Need help? Reply to this email and we’ll assist.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:16px 8px 0 8px;">
                  <p class="muted" style="margin:0 0 8px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                    You’re receiving this because you created a profile on EduVault.
                  </p>
                  <p class="muted" style="margin:0 0 24px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                    © ${new Date().getFullYear()} EduVault
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;

  await withEmailResilience('send.welcome', () => transporter.sendMail({ from, to, subject, text, html }), { idempotent: false });
}

export async function verifyEmailConnection() {
  const transporter = createTransporter();
  await withEmailResilience('verify', () => transporter.verify());
}
