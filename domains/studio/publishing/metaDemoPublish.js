// Meta App Review demo-publish helper.
//
// During Meta App Review, the demo workspace's FACEBOOK / INSTAGRAM
// ChannelConnection rows hold sentinel encrypted tokens (see the
// `--meta-demo` flag in scripts/seed-analytics.js). Real Meta API
// calls would fail because those tokens are not real.
//
// When `META_APP_REVIEW_DEMO=true` (server runtime env) AND the
// channel is FACEBOOK or INSTAGRAM, this helper short-circuits the
// adapter call and synthesizes a successful publish result with a
// Meta-shaped externalPostId + externalPostUrl. The rest of the
// publishing pipeline (draft transition to PUBLISHED, planner update,
// notifications) runs normally — so reviewers see an end-to-end
// Published state in the UI.
//
// Production workspaces are unaffected: when the env flag is unset
// (or "false"), `isMetaDemoPublish` returns false and we go through
// the real adapter path.

const FACEBOOK_PAGE_ID = "100000000000001";
const FACEBOOK_PAGE_HANDLE = "SquadpitchTest";

export function isMetaDemoPublish(channel) {
  if (channel !== "FACEBOOK" && channel !== "INSTAGRAM") return false;
  return String(process.env.META_APP_REVIEW_DEMO ?? "").toLowerCase() === "true";
}

export function simulateMetaDemoPublish({ draft }) {
  // Use the draft id's tail as a stable but distinct numeric suffix so
  // re-publishing the same draft yields the same fake URL (idempotent).
  const tail = String(draft.id ?? "").replace(/[^0-9a-z]/gi, "").slice(-12) || "demo";
  const numericSuffix = BigInt(`0x${tail.replace(/[^0-9a-f]/gi, "0")}`)
    .toString()
    .slice(-15)
    .padStart(15, "1");

  if (draft.channel === "FACEBOOK") {
    const externalPostId = `${FACEBOOK_PAGE_ID}_${numericSuffix.padStart(16, "1")}`;
    const externalPostUrl = `https://www.facebook.com/${FACEBOOK_PAGE_HANDLE}/posts/${numericSuffix}`;
    return { externalPostId, externalPostUrl };
  }

  // INSTAGRAM
  const externalPostId = numericSuffix.padStart(17, "1");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let code = "C";
  for (let n = 0; n < 10; n++) {
    code += alphabet[(numericSuffix.charCodeAt(n % numericSuffix.length) + n * 7) % alphabet.length];
  }
  const externalPostUrl = `https://www.instagram.com/p/${code}/`;
  return { externalPostId, externalPostUrl };
}
