// Simulate a Meta Inbox webhook delivery.
//
// Builds a Facebook Page feed comment payload (or Instagram
// comment payload), HMAC-SHA256 signs it with META_APP_SECRET,
// and POSTs it to the production /api/v1/webhooks/meta/inbox
// route. The receiver + ingestion service runs end-to-end as
// if Meta had delivered the event — perfect for testing the
// SquadInbox foundation BEFORE the actual Meta webhook
// subscription is wired in the App Dashboard.
//
// Usage (run from squadpitch-api/):
//
//   node scripts/test-meta-inbox-webhook.js \
//     --page-id=1142546645600822 \
//     --post-id=1142546645600822_900000 \
//     --comment-id=fb_comment_12345 \
//     --from-id=fb_user_99 \
//     --from-name="Test Commenter" \
//     --text="How much is this home selling for?"
//
// For Instagram, swap to --object=instagram and pass --ig-account-id
// (which is the connected IG business account id):
//
//   node scripts/test-meta-inbox-webhook.js \
//     --object=instagram \
//     --ig-account-id=17841400000000000 \
//     --media-id=ig_media_42 \
//     --comment-id=ig_comment_42 \
//     --from-id=ig_user_42 \
//     --from-username=daniel \
//     --text="Love this!"
//
// Flags:
//   --url=<override>          default: https://squadpitch-api.fly.dev/api/v1/webhooks/meta/inbox
//   --app-secret=<secret>     default: $META_APP_SECRET (must match Fly's value)
//   --dry-run                 prints the payload + signature, does NOT POST

import { createHmac, randomBytes } from "node:crypto";

const DEFAULT_URL = "https://squadpitch-api.fly.dev/api/v1/webhooks/meta/inbox";

function parseArgs() {
  const args = { object: "page", dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const m = /^--([a-z-]+)=(.*)$/i.exec(a);
    if (m) args[camel(m[1])] = m[2];
  }
  return args;
}
function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function buildPageCommentPayload(args) {
  if (!args.pageId) bail("--page-id is required for object=page");
  return {
    object: "page",
    entry: [
      {
        id: args.pageId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "feed",
            value: {
              item: "comment",
              verb: "add",
              comment_id: args.commentId ?? `sim_c_${randomBytes(6).toString("hex")}`,
              post_id: args.postId ?? `${args.pageId}_${randomBytes(4).toString("hex")}`,
              created_time: Math.floor(Date.now() / 1000),
              message: args.text ?? "Test comment from simulator.",
              from: {
                id: args.fromId ?? `sim_u_${randomBytes(6).toString("hex")}`,
                name: args.fromName ?? "Sim Commenter",
              },
              permalink_url: args.permalink ?? null,
            },
          },
        ],
      },
    ],
  };
}

function buildInstagramCommentPayload(args) {
  if (!args.igAccountId) bail("--ig-account-id is required for object=instagram");
  return {
    object: "instagram",
    entry: [
      {
        id: args.igAccountId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "comments",
            value: {
              id: args.commentId ?? `sim_ic_${randomBytes(6).toString("hex")}`,
              text: args.text ?? "Test IG comment from simulator.",
              created_time: Math.floor(Date.now() / 1000),
              from: {
                id: args.fromId ?? `sim_iu_${randomBytes(6).toString("hex")}`,
                username: args.fromUsername ?? args.fromName ?? "sim_commenter",
              },
              media: {
                id: args.mediaId ?? `sim_im_${randomBytes(4).toString("hex")}`,
                permalink: args.permalink ?? null,
              },
            },
          },
        ],
      },
    ],
  };
}

function bail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs();
  const url = args.url ?? DEFAULT_URL;
  const appSecret = args.appSecret ?? process.env.META_APP_SECRET;
  if (!appSecret) bail("META_APP_SECRET not set in env; pass --app-secret=<value>");

  const payload =
    args.object === "instagram"
      ? buildInstagramCommentPayload(args)
      : buildPageCommentPayload(args);
  const body = JSON.stringify(payload);
  const signature =
    "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex");

  console.log("──────────────────────────────────────────────────────");
  console.log("POST", url);
  console.log("X-Hub-Signature-256:", signature);
  console.log("Body:", body);
  console.log("──────────────────────────────────────────────────────");

  if (args.dryRun) {
    console.log("(--dry-run) not sending.");
    return;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    },
    body,
  });
  const text = await res.text();
  console.log(`→ HTTP ${res.status}`);
  console.log(text);
}

main().catch((err) => {
  console.error("failed:", err?.message ?? err);
  process.exit(1);
});
