// Onboarding email via Resend (yourdomain.com is a verified sending domain).
// Templates are table-based with inline styles so they render correctly in
// Gmail, Outlook, and Apple Mail. Logo is a hosted PNG (email clients don't
// render SVG).
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const MAIL_FROM = process.env.MAIL_FROM ?? "Fieldline <your-app-domain>";
const APP_URL = process.env.APP_URL ?? "https://your-app-domain";
const LOGO_URL = `${APP_URL}/logo-email.png`;

export async function sendMail(to: string, subject: string, html: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { ok: false, error: "email not configured (RESEND_API_KEY missing)" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, error: `Resend HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e as Error).message) }; }
}

const F = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
// Escape user-controlled fields (org name, person name) before they enter HTML,
// so a crafted org name can't inject markup/links into onboarding emails.
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

function shell(inner: string, recipientEmail: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#eef2ef;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2ef">
<tr><td align="center" style="padding:40px 16px;">

  <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

    <!-- logo -->
    <tr><td align="center" style="padding:0 0 24px;">
      <img src="${LOGO_URL}" width="56" height="56" alt="Fieldline" style="display:block;border:0;border-radius:14px;"/>
      <div style="${F}font-size:17px;font-weight:700;color:#0d1c14;letter-spacing:-0.3px;margin-top:10px;">Fieldline&nbsp;<span style="color:#0f8a57;">One</span></div>
      <div style="${F}font-size:10px;font-weight:600;color:#93a29a;letter-spacing:2.4px;margin-top:3px;">LORAWAN OPERATIONS</div>
    </td></tr>

    <!-- card -->
    <tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e2e8e3;border-radius:16px;padding:36px 40px;">
      ${inner}
    </td></tr>

    <!-- footer -->
    <tr><td align="center" style="padding:24px 20px 0;">
      <div style="${F}font-size:12px;line-height:19px;color:#93a29a;">
        Fieldline &middot; Private LoRaWAN sensor networks for schools and campuses<br/>
        You're receiving this because an administrator created a Fieldline account for ${esc(recipientEmail)}.
      </div>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}

function credentialRows(email: string, password: string): string {
  const row = (label: string, value: string, mono = false, last = false) => `
  <tr>
    <td style="${F}padding:12px 18px;font-size:12px;color:#7c8a80;width:150px;${last ? "" : "border-bottom:1px solid #e8eee9;"}">${label}</td>
    <td style="${F}padding:12px 18px;font-size:14px;font-weight:600;color:#0d1c14;${mono ? "font-family:Menlo,Consolas,'Courier New',monospace;letter-spacing:0.4px;" : ""}${last ? "" : "border-bottom:1px solid #e8eee9;"}">${value}</td>
  </tr>`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f6f9f7" style="background-color:#f6f9f7;border:1px solid #e2e8e3;border-radius:12px;margin:24px 0;">
    ${row("Sign-in address", `<a href="${APP_URL}" style="color:#0f8a57;text-decoration:none;">${APP_URL.replace("https://", "")}</a>`)}
    ${row("Email", esc(email))}
    ${row("Temporary password", esc(password), true, true)}
  </table>`;
}

function ctaButton(label: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:4px auto 0;">
    <tr><td bgcolor="#0f8a57" style="background-color:#0f8a57;border-radius:10px;">
      <a href="${APP_URL}" style="${F}display:inline-block;padding:13px 34px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${label}</a>
    </td></tr>
  </table>`;
}

const securityNote = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
    <tr><td style="${F}border-top:1px solid #e8eee9;padding-top:20px;font-size:13px;line-height:20px;color:#7c8a80;">
      <strong style="color:#5c6b60;">Security note:</strong> on your first sign-in you'll be asked to choose your own password.
      The temporary password above stops working immediately after. If you weren't expecting this email, you can safely ignore it.
    </td></tr>
  </table>`;

export function welcomeOrgEmail(p: { orgName: string; name: string; email: string; tempPassword: string }) {
  const subject = `Your ${p.orgName} workspace is ready`;
  const html = shell(`
    <h1 style="${F}margin:0 0 14px;font-size:22px;line-height:30px;font-weight:700;color:#0d1c14;letter-spacing:-0.3px;">
      ${esc(p.orgName)} is ready on Fieldline</h1>
    <p style="${F}margin:0;font-size:15px;line-height:24px;color:#41504a;">
      Hi ${esc(p.name)},</p>
    <p style="${F}margin:14px 0 0;font-size:15px;line-height:24px;color:#41504a;">
      A private sensor-network workspace for <strong>${esc(p.orgName)}</strong> has been created, with you as its administrator.
      From one console you can connect gateways, add sensors with step-by-step setup guides, watch live readings, and route data to any system you use.</p>
    ${credentialRows(p.email, p.tempPassword)}
    ${ctaButton("Sign in to Fieldline")}
    ${securityNote}`, p.email);
  const text = `${p.orgName} is ready on Fieldline

Hi ${esc(p.name)},

A private sensor-network workspace for ${p.orgName} has been created, with you as its administrator.

Sign in:              ${APP_URL}
Email:                ${p.email}
Temporary password:   ${p.tempPassword}

Security note: on your first sign-in you'll be asked to choose your own password. The temporary password stops working immediately after.`;
  return { subject, html, text };
}

export function operatorEmail(p: { name: string; email: string; tempPassword?: string; adminUrl: string }) {
  const subject = "You're now a Fieldline platform operator";
  const cred = p.tempPassword ? credentialRows(p.email, p.tempPassword) : `
    <p style="${F}margin:14px 0 24px;font-size:15px;line-height:24px;color:#41504a;">
      Sign in with your existing Fieldline password.</p>`;
  const html = shell(`
    <h1 style="${F}margin:0 0 14px;font-size:22px;line-height:30px;font-weight:700;color:#0d1c14;letter-spacing:-0.3px;">
      Welcome to the operator team</h1>
    <p style="${F}margin:0;font-size:15px;line-height:24px;color:#41504a;">
      Hi ${esc(p.name)},</p>
    <p style="${F}margin:14px 0 0;font-size:15px;line-height:24px;color:#41504a;">
      You've been made a <strong>platform operator</strong> on Fieldline. Operators onboard new organizations:
      you fill in a school's name and contact, and the platform builds their private workspace and sends them their login.</p>
    ${cred}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:4px auto 0;">
      <tr><td bgcolor="#0f8a57" style="background-color:#0f8a57;border-radius:10px;">
        <a href="${p.adminUrl}" style="${F}display:inline-block;padding:13px 34px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open the Operator console</a>
      </td></tr>
    </table>
    ${p.tempPassword ? securityNote : ""}`, p.email);
  const text = `Welcome to the operator team

Hi ${esc(p.name)},

You've been made a platform operator on Fieldline. Operators onboard new organizations: you fill in a school's name and contact, and the platform builds their private workspace and sends them their login.

Operator console: ${p.adminUrl}
${p.tempPassword ? `Email: ${p.email}\nTemporary password: ${p.tempPassword}\n\nOn your first sign-in you'll be asked to choose your own password.` : "Sign in with your existing Fieldline password."}`;
  return { subject, html, text };
}

export function addedUserEmail(p: { orgName: string; name: string; email: string; tempPassword: string; role: string }) {
  const subject = `You've been added to ${p.orgName} on Fieldline`;
  const html = shell(`
    <h1 style="${F}margin:0 0 14px;font-size:22px;line-height:30px;font-weight:700;color:#0d1c14;letter-spacing:-0.3px;">
      Welcome to ${esc(p.orgName)}</h1>
    <p style="${F}margin:0;font-size:15px;line-height:24px;color:#41504a;">
      Hi ${esc(p.name)},</p>
    <p style="${F}margin:14px 0 0;font-size:15px;line-height:24px;color:#41504a;">
      You've been given <strong>${esc(p.role)}</strong> access to ${p.orgName}'s sensor network on Fieldline — live readings, device status, and data tools in one console.</p>
    ${credentialRows(p.email, p.tempPassword)}
    ${ctaButton("Sign in to Fieldline")}
    ${securityNote}`, p.email);
  const text = `Welcome to ${p.orgName}

Hi ${esc(p.name)},

You've been given ${p.role} access to ${p.orgName}'s sensor network on Fieldline.

Sign in:              ${APP_URL}
Email:                ${p.email}
Temporary password:   ${p.tempPassword}

Security note: on your first sign-in you'll be asked to choose your own password. The temporary password stops working immediately after.`;
  return { subject, html, text };
}
