import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const SYNTHETIC_MARKER = "[SYNTHETIC CANARY]";

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadSafeConfig(env = process.env) {
  const apiBaseUrl = new URL(required(env, "POSTMARK_CANARY_API_BASE_URL"));
  if (apiBaseUrl.protocol !== "https:") throw new Error("Canary API URL must use HTTPS");
  const recipient = required(env, "POSTMARK_CANARY_RECIPIENT").toLowerCase();
  const allowedRecipient = required(env, "POSTMARK_CANARY_ALLOWED_RECIPIENT").toLowerCase();
  if (recipient !== allowedRecipient) {
    throw new Error("Recipient does not exactly match the synthetic allowlist");
  }
  return {
    apiBaseUrl: apiBaseUrl.toString().replace(/\/$/, ""),
    accessToken: required(env, "POSTMARK_CANARY_ACCESS_TOKEN"),
    workspaceId: required(env, "POSTMARK_CANARY_WORKSPACE_ID"),
    allowedWorkspaceId: required(env, "POSTMARK_CANARY_ALLOWED_WORKSPACE_ID"),
    conversationId: required(env, "POSTMARK_CANARY_CONVERSATION_ID"),
    recipient,
  };
}

export function assertSyntheticScope(config, conversation) {
  if (config.workspaceId !== config.allowedWorkspaceId) {
    throw new Error("Workspace does not exactly match the synthetic allowlist");
  }
  if (!conversation || conversation.id !== config.conversationId) {
    throw new Error("Synthetic conversation was not resolved");
  }
  const email = String(conversation.contact?.email || "").toLowerCase();
  if (email !== config.recipient) {
    throw new Error("Conversation recipient does not match the synthetic allowlist");
  }
  const label = [conversation.subject, conversation.contact?.name]
    .filter(Boolean)
    .join(" ");
  if (!label.includes(SYNTHETIC_MARKER)) {
    throw new Error(`Conversation or contact must contain ${SYNTHETIC_MARKER}`);
  }
}

async function api(config, path, init = {}) {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Canary API request failed (${response.status})`);
  return body;
}

async function getConversation(config) {
  const body = await api(
    config,
    `/api/v1/workspaces/${encodeURIComponent(config.workspaceId)}/inbox/conversations/${encodeURIComponent(config.conversationId)}`,
  );
  assertSyntheticScope(config, body.conversation);
  return body.conversation;
}

export async function sendSynthetic(config, correlationId = randomUUID()) {
  const text = `${SYNTHETIC_MARKER} Postmark outbound and reply verification. Correlation: ${correlationId}. Reply to this message without removing the correlation marker.`;
  const subject = `${SYNTHETIC_MARKER} Postmark outbound verification`;
  const body = await api(
    config,
    "/api/v1/internal/canary/postmark/send",
    {
      method: "POST",
      body: JSON.stringify({
        workspaceId: config.workspaceId,
        conversationId: config.conversationId,
        recipient: config.recipient,
        body: text,
        subject,
        correlationId,
      }),
    },
  );
  if (body.status !== "SENT" || body.providerMessageIdPersisted !== true) {
    throw new Error("Postmark did not produce a SENT message with a provider ID");
  }
  if (!body.senderConfigured || !body.replyToThreadingConfigured) {
    throw new Error("Postmark sender or reply threading evidence is incomplete");
  }
  return { correlationId, messageId: body.messageId };
}

export async function verifySynthetic(config, correlationId) {
  const conversation = await getConversation(config);
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const matching = messages.filter((message) =>
    String(message.body || "").includes(correlationId),
  );
  const outbound = matching.filter((message) => message.party === "WORKSPACE");
  const inbound = matching.filter((message) => message.party === "CONTACT");
  if (outbound.length !== 1) throw new Error("Expected exactly one synthetic outbound message");
  if (inbound.length !== 1) throw new Error("Expected exactly one synthetic inbound reply");
  if (!outbound[0].providerMessageId || !inbound[0].externalMessageId) {
    throw new Error("Provider message evidence is incomplete");
  }
  return { outboundCount: 1, inboundCount: 1, verified: true };
}

async function main() {
  const config = loadSafeConfig();
  const command = process.argv[2];
  if (command === "send") {
    const result = await sendSynthetic(config);
    console.log(JSON.stringify({ status: "SENT", correlationId: result.correlationId }));
    console.log("Reply from the allowlisted mailbox, preserving the correlation marker, then run verify <correlationId>.");
    return;
  }
  if (command === "verify") {
    const correlationId = String(process.argv[3] || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(correlationId)) throw new Error("A valid correlation ID is required");
    console.log(JSON.stringify(await verifySynthetic(config, correlationId)));
    return;
  }
  throw new Error("Usage: npm run verify:postmark-delivery -- send|verify <correlationId>");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
