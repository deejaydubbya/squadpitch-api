// HTML email templates for Squadpitch notification events.
// Only the 5 supported event types have templates here.

import { env } from "../../config/env.js";

const APP = env.APP_URL;

function wrap(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#111318;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 24px">
<div style="background:#1a1d24;border-radius:12px;padding:32px;border:1px solid #2a2d34">
<h1 style="color:#fff;font-size:20px;margin:0 0 16px">${title}</h1>
${bodyHtml}
</div>
<p style="text-align:center;color:#666;font-size:11px;margin-top:24px">
Squadpitch &middot; <a href="${APP}/clients" style="color:#4ade80">Open Dashboard</a>
</p>
</div>
</body>
</html>`;
}

function btn(label, href) {
  return `<a href="${href}" style="display:inline-block;background:#4ade80;color:#111;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;margin-top:16px">${label}</a>`;
}

// ── Email templates ─────────────────────────────────────────────────────

export const templates = {
  POST_PUBLISHED({ channel, body, externalPostUrl, clientId }) {
    const preview = (body || "").slice(0, 200);
    const publishTime = new Date().toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return {
      subject: "Your post is live 🎉",
      html: wrap("Your post is live!", `
        <p style="color:#ccc;font-size:14px;line-height:1.6;margin:0 0 8px">
          Your <strong style="color:#fff">${channel}</strong> post has been published successfully.
        </p>
        <p style="color:#999;font-size:12px;margin:0 0 12px">Published at ${publishTime}</p>
        <div style="background:#111318;border-radius:8px;padding:16px;margin:16px 0;border-left:3px solid #4ade80">
          <p style="color:#aaa;font-size:13px;margin:0;line-height:1.5">${preview}${body?.length > 200 ? "..." : ""}</p>
        </div>
        ${externalPostUrl ? btn("View Post", externalPostUrl) : btn("Open Dashboard", `${APP}/clients/${clientId}`)}
      `),
    };
  },

  POST_FAILED({ channel, error, clientId, body }) {
    const preview = (body || "").slice(0, 120);
    return {
      subject: "We couldn't publish your post",
      html: wrap("Publishing Failed", `
        <p style="color:#ccc;font-size:14px;line-height:1.6;margin:0 0 8px">
          Your <strong style="color:#fff">${channel}</strong> post failed to publish.
        </p>
        ${preview ? `
        <div style="background:#111318;border-radius:8px;padding:12px;margin:12px 0;border-left:3px solid #666">
          <p style="color:#999;font-size:12px;margin:0;line-height:1.4">${preview}${body?.length > 120 ? "..." : ""}</p>
        </div>` : ""}
        <div style="background:#111318;border-radius:8px;padding:16px;margin:16px 0;border-left:3px solid #f87171">
          <p style="color:#f87171;font-size:13px;margin:0"><strong>Reason:</strong> ${error || "Unknown error"}</p>
        </div>
        <p style="color:#999;font-size:13px;margin:8px 0 0">Check your channel connections and try again.</p>
        <div style="margin-top:16px">
          ${btn("Reconnect Account", `${APP}/clients/${clientId}/settings/channels`)}
          <span style="display:inline-block;width:8px"></span>
          ${btn("Go to Dashboard", `${APP}/clients/${clientId}`)}
        </div>
      `),
    };
  },

  USAGE_LIMIT_NEARING({ field, current, limit, tier }) {
    const pct = Math.round((current / limit) * 100);
    return {
      subject: "You're close to your Squadpitch limit",
      html: wrap("Usage Alert", `
        <p style="color:#ccc;font-size:14px;line-height:1.6;margin:0 0 8px">
          You've used <strong style="color:#fff">${pct}%</strong> of your monthly <strong style="color:#fff">${field}</strong> on the <strong style="color:#fff">${tier}</strong> plan.
        </p>
        <div style="background:#111318;border-radius:8px;padding:16px;margin:16px 0">
          <div style="background:#333;border-radius:4px;height:8px;overflow:hidden">
            <div style="background:${pct >= 90 ? "#f87171" : "#fbbf24"};height:100%;width:${pct}%;border-radius:4px"></div>
          </div>
          <p style="color:#999;font-size:12px;margin:8px 0 0">${current} / ${limit} ${field} used</p>
        </div>
        ${btn("Upgrade Plan", `${APP}/pricing`)}
      `),
    };
  },

  CONNECTION_EXPIRED({ channel, clientId }) {
    return {
      subject: "Reconnect your account to keep publishing",
      html: wrap("Connection Expired", `
        <p style="color:#ccc;font-size:14px;line-height:1.6;margin:0 0 8px">
          Your <strong style="color:#fff">${channel}</strong> connection has expired.
          Please reconnect to continue publishing.
        </p>
        ${btn("Reconnect", `${APP}/clients/${clientId}/settings/channels`)}
      `),
    };
  },

  BATCH_COMPLETE({ count, clientId }) {
    return {
      subject: "Your content is ready",
      html: wrap("Batch Complete", `
        <p style="color:#ccc;font-size:14px;line-height:1.6;margin:0 0 8px">
          <strong style="color:#fff">${count}</strong> post${count !== 1 ? "s have" : " has"} been generated and ${count !== 1 ? "are" : "is"} ready for review.
        </p>
        ${btn("Review Content", `${APP}/clients/${clientId}/planner`)}
      `),
    };
  },
};

// ── SMS templates (critical events only) ────────────────────────────────

export const smsTemplates = {
  POST_FAILED() {
    return "Squadpitch: Your post failed to publish. Check your dashboard to fix it.";
  },
  CONNECTION_EXPIRED() {
    return "Squadpitch: Your account connection expired. Reconnect in Squadpitch.";
  },
};
