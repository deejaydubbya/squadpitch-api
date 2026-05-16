// Backfill an existing Facebook Page post as a Squadpitch Draft.
//
// Use when a post was created directly on the FB Page (not via
// Squadpitch) and you want it tracked as if Squadpitch had
// published it — Studio library shows it, and future Inbox
// conversations on its comments will deep-link back to a real
// Draft row.
//
// Usage:
//
//   # List the page's most recent posts (pick the id from output)
//   node scripts/backfill-fb-published-post.js \
//     --client-id=<workspace cuid> \
//     --list
//
//   # Backfill a specific post:
//   node scripts/backfill-fb-published-post.js \
//     --client-id=<workspace cuid> \
//     --post-id=<numeric pageid_postid>
//
//   # Backfill the latest post automatically:
//   node scripts/backfill-fb-published-post.js \
//     --client-id=<workspace cuid> \
//     --latest
//
// Requires TOKEN_ENCRYPTION_KEY in env (already in .env locally).
// Uses the FACEBOOK ChannelConnection's stored access token to call
// Graph API. Page id is read off the connection — no separate flag.

import { PrismaClient } from "@prisma/client";
import { decryptToken } from "../lib/tokenCrypto.js";
import { META_GRAPH_BASE } from "../domains/studio/meta.constants.js";

const prisma = new PrismaClient();

function parseArgs() {
  const args = { list: false, latest: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--list") args.list = true;
    else if (a === "--latest") args.latest = true;
    else {
      const m = /^--([a-z-]+)=(.*)$/i.exec(a);
      if (m) args[camel(m[1])] = m[2];
    }
  }
  return args;
}
function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function bail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

async function loadConnection(clientId) {
  const conn = await prisma.channelConnection.findFirst({
    where: { clientId, channel: "FACEBOOK", status: "CONNECTED" },
  });
  if (!conn) {
    bail(`no CONNECTED Facebook ChannelConnection for clientId=${clientId}`);
  }
  const token = decryptToken(conn.accessToken);
  return { conn, token };
}

async function listRecentPosts({ pageId, token, limit = 10 }) {
  const url =
    `${META_GRAPH_BASE}/${pageId}/posts` +
    `?fields=id,message,created_time,permalink_url,full_picture,attachments{media_type,media,url}` +
    `&limit=${limit}` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    bail(
      `Graph API GET /${pageId}/posts failed: ${res.status} ${body?.error?.message ?? JSON.stringify(body)}`,
    );
  }
  return Array.isArray(body?.data) ? body.data : [];
}

async function fetchPost({ postId, token }) {
  const url =
    `${META_GRAPH_BASE}/${postId}` +
    `?fields=id,message,created_time,permalink_url,full_picture,attachments{media_type,media,url}` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    bail(
      `Graph API GET /${postId} failed: ${res.status} ${body?.error?.message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

function pickMediaUrl(post) {
  if (typeof post?.full_picture === "string") return { mediaUrl: post.full_picture, mediaType: "image" };
  const att = post?.attachments?.data?.[0];
  if (att?.media?.image?.src) return { mediaUrl: att.media.image.src, mediaType: "image" };
  if (att?.media_type === "video" && att?.media?.source) return { mediaUrl: att.media.source, mediaType: "video" };
  return { mediaUrl: null, mediaType: null };
}

async function insertDraft({ clientId, conn, post }) {
  // Check for an existing Draft on this externalPostId to avoid
  // duplicates — running the script twice is a no-op.
  const existing = await prisma.draft.findFirst({
    where: { clientId, channel: "FACEBOOK", externalPostId: post.id },
    select: { id: true, status: true },
  });
  if (existing) {
    console.log(
      `[backfill-fb] Draft already exists: ${existing.id} (status=${existing.status})`,
    );
    return existing;
  }

  const { mediaUrl, mediaType } = pickMediaUrl(post);
  const publishedAt = post.created_time ? new Date(post.created_time) : new Date();

  const draft = await prisma.draft.create({
    data: {
      clientId,
      kind: "POST",
      channel: "FACEBOOK",
      status: "PUBLISHED",
      generationGuidance: "[backfill] post created directly on the FB Page",
      body: typeof post.message === "string" ? post.message : "",
      hooks: [],
      hashtags: [],
      mediaUrl,
      mediaType,
      externalPostId: post.id,
      externalPostUrl: typeof post.permalink_url === "string" ? post.permalink_url : null,
      publishAttempts: 1,
      lastPublishAttemptAt: publishedAt,
      publishedAt,
      publishSource: "backfill",
      createdBy: conn.createdBy,
    },
  });
  console.log(`[backfill-fb] created Draft ${draft.id}`);
  console.log(`  externalPostId : ${draft.externalPostId}`);
  console.log(`  externalPostUrl: ${draft.externalPostUrl}`);
  return draft;
}

async function main() {
  const args = parseArgs();
  if (!args.clientId) bail("--client-id is required");

  const { conn, token } = await loadConnection(args.clientId);
  console.log(
    `[backfill-fb] using FACEBOOK connection ${conn.id} (page ${conn.externalAccountId} — ${conn.displayName ?? "no display name"})`,
  );

  if (args.list) {
    const posts = await listRecentPosts({ pageId: conn.externalAccountId, token });
    console.log(`\nMost recent ${posts.length} post(s) on this Page:\n`);
    for (const p of posts) {
      const msg = (p.message ?? "").replace(/\s+/g, " ").slice(0, 100);
      console.log(`  id=${p.id}`);
      console.log(`    created=${p.created_time}`);
      console.log(`    permalink=${p.permalink_url}`);
      console.log(`    body=${msg || "(no body)"}`);
      console.log();
    }
    console.log(
      "Re-run with --post-id=<id> to backfill one, or --latest to take the most recent.",
    );
    return;
  }

  let post;
  if (args.postId) {
    post = await fetchPost({ postId: args.postId, token });
  } else if (args.latest) {
    const recent = await listRecentPosts({ pageId: conn.externalAccountId, token, limit: 1 });
    if (recent.length === 0) bail("no posts returned by Graph API");
    post = recent[0];
    console.log(`[backfill-fb] using latest post ${post.id}`);
  } else {
    bail("provide --post-id=<id>, --latest, or --list");
  }

  await insertDraft({ clientId: args.clientId, conn, post });
}

main()
  .catch((err) => {
    console.error("failed:", err?.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
