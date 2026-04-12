// Weekly digest email template.

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

function statCard(label, value, color = "#fff") {
  return `<div style="flex:1;text-align:center;padding:12px">
    <div style="color:${color};font-size:24px;font-weight:700">${value}</div>
    <div style="color:#999;font-size:12px;margin-top:4px">${label}</div>
  </div>`;
}

/**
 * Build weekly digest email.
 * @param {object} data
 * @param {string} data.userName
 * @param {string} data.periodLabel - e.g. "Apr 4 – Apr 10, 2026"
 * @param {number} data.postsPublished
 * @param {number} data.postsScheduled
 * @param {number} data.postsFailed
 * @param {number} data.totalImpressions
 * @param {number} data.totalEngagement
 * @param {{ channel: string, body: string, engagement: number }|null} data.topPost
 * @param {string} [data.clientId]
 */
export function buildDigestEmail(data) {
  const {
    userName,
    periodLabel,
    postsPublished,
    postsScheduled,
    postsFailed,
    totalImpressions,
    totalEngagement,
    topPost,
    clientId,
  } = data;

  const greeting = userName ? `Hi ${userName},` : "Hi,";
  const dashboardUrl = clientId ? `${APP}/clients/${clientId}` : `${APP}/dashboard`;

  let statsRow = `<div style="display:flex;background:#111318;border-radius:8px;margin:16px 0">
    ${statCard("Published", postsPublished, "#4ade80")}
    ${statCard("Scheduled", postsScheduled)}
    ${statCard("Failed", postsFailed, postsFailed > 0 ? "#f87171" : "#fff")}
  </div>`;

  let metricsRow = "";
  if (totalImpressions > 0 || totalEngagement > 0) {
    metricsRow = `<div style="display:flex;background:#111318;border-radius:8px;margin:0 0 16px">
      ${statCard("Impressions", totalImpressions.toLocaleString())}
      ${statCard("Engagements", totalEngagement.toLocaleString())}
    </div>`;
  }

  let topPostBlock = "";
  if (topPost) {
    const preview = (topPost.body || "").slice(0, 120);
    topPostBlock = `
    <div style="margin:16px 0">
      <p style="color:#999;font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.5px">Top Performing Post</p>
      <div style="background:#111318;border-radius:8px;padding:14px;border-left:3px solid #4ade80">
        <p style="color:#fff;font-size:13px;margin:0 0 4px;font-weight:600">${topPost.channel}</p>
        <p style="color:#aaa;font-size:12px;margin:0 0 6px;line-height:1.4">${preview}${topPost.body?.length > 120 ? "..." : ""}</p>
        <p style="color:#4ade80;font-size:12px;margin:0">${topPost.engagement} engagements</p>
      </div>
    </div>`;
  }

  let actionBlock = "";
  if (postsFailed > 0) {
    actionBlock = `<p style="color:#f87171;font-size:13px;margin:12px 0 0">
      ${postsFailed} post${postsFailed > 1 ? "s" : ""} failed this week and may need your attention.
    </p>`;
  }

  return {
    subject: `Your weekly Squadpitch summary — ${periodLabel}`,
    html: wrap("Weekly Summary", `
      <p style="color:#ccc;font-size:14px;line-height:1.6;margin:0 0 4px">${greeting}</p>
      <p style="color:#999;font-size:13px;margin:0 0 16px">Here's what happened in Squadpitch this week (${periodLabel}).</p>
      ${statsRow}
      ${metricsRow}
      ${topPostBlock}
      ${actionBlock}
      ${btn("Open Dashboard", dashboardUrl)}
    `),
  };
}
