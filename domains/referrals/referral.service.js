import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { prisma } from "../../prisma.js";
import { STRIPE_API_VERSION } from "../billing/stripeSafety.js";
import { issueReferralCapture, verifyReferralCapture } from "./referral.tokens.js";

export const REFERRAL_REWARD_CENTS = 5900;
export const REFERRAL_CURRENCY = "usd";
export const QUALIFICATION_MS = 14 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SYNTHETIC_EMAIL = /(^|[+._-])(admin|canary|e2e|synthetic|test)([+._-]|@)/i;
const REFERRAL_E2E_REFERRER_EMAIL = "e2e-user@squadpitch.com";

export function generateReferralCode(bytes = randomBytes(12)) {
  let code = "";
  for (let i = 0; i < 12; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

export function isExcludedReferralEmail(email) {
  return !email || email.endsWith("@unknown") || SYNTHETIC_EMAIL.test(email);
}

export async function getOrCreateReferralCode(user, prismaClient = prisma) {
  if (isExcludedReferralEmail(user.email) && user.email.toLowerCase() !== REFERRAL_E2E_REFERRER_EMAIL) throw Object.assign(new Error("This account is not eligible for referrals"), { status: 403, code: "REFERRAL_ACCOUNT_EXCLUDED" });
  const existing = await prismaClient.referralCode.findUnique({ where: { ownerUserId: user.id } });
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await prismaClient.referralCode.create({ data: { ownerUserId: user.id, code: generateReferralCode() } }); }
    catch (error) { if (error?.code !== "P2002") throw error; }
  }
  throw Object.assign(new Error("Unable to allocate referral code"), { status: 503, code: "REFERRAL_CODE_UNAVAILABLE" });
}

export async function createCaptureForCode(code, { now = new Date(), prismaClient = prisma } = {}) {
  const row = await prismaClient.referralCode.findFirst({ where: { code: String(code || "").toUpperCase(), active: true }, select: { id: true } });
  if (!row) return null;
  return { token: issueReferralCapture(row.id, now), expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) };
}

export async function attachReferralAttribution({ captureToken, user, now = new Date(), prismaClient = prisma }) {
  const capture = verifyReferralCapture(captureToken, now);
  if (!capture) throw Object.assign(new Error("Referral attribution is invalid or expired"), { status: 400, code: "REFERRAL_CAPTURE_INVALID" });
  const existing = await prismaClient.referral.findUnique({ where: { referredUserId: user.id } });
  if (existing) return { attached: true, idempotent: true };
  const code = await prismaClient.referralCode.findFirst({ where: { id: capture.codeId, active: true } });
  if (!code) throw Object.assign(new Error("Referral code is no longer available"), { status: 410, code: "REFERRAL_CODE_INACTIVE" });
  if (code.ownerUserId === user.id) throw Object.assign(new Error("You cannot refer yourself"), { status: 409, code: "SELF_REFERRAL" });
  const owner = await prismaClient.user.findUnique({ where: { id: code.ownerUserId }, select: { email: true } });
  if (!owner || isExcludedReferralEmail(owner.email)) throw Object.assign(new Error("This referral code is not eligible for attribution"), { status: 403, code: "REFERRAL_OWNER_EXCLUDED" });
  if (isExcludedReferralEmail(user.email)) throw Object.assign(new Error("This account is excluded from referral attribution"), { status: 403, code: "REFERRAL_ACCOUNT_EXCLUDED" });
  if (user.createdAt < new Date(capture.capturedAt.getTime() - 5 * 60 * 1000)) throw Object.assign(new Error("Existing accounts cannot be referred retroactively"), { status: 409, code: "REFERRAL_EXISTING_ACCOUNT" });
  const paid = await prismaClient.subscription.findUnique({ where: { userId: user.id } });
  if (paid?.stripeSubscriptionId) throw Object.assign(new Error("Existing paid accounts cannot be referred"), { status: 409, code: "REFERRAL_EXISTING_CUSTOMER" });
  const reverse = await prismaClient.referral.findFirst({ where: { referrerUserId: user.id, referredUserId: code.ownerUserId } });
  if (reverse) throw Object.assign(new Error("Circular referrals are not allowed"), { status: 409, code: "REFERRAL_CIRCULAR" });
  try {
    await prismaClient.referral.create({ data: { referralCodeId: code.id, referrerUserId: code.ownerUserId, referredUserId: user.id, attributedAt: now } });
  } catch (error) {
    if (error?.code === "P2002") return { attached: true, idempotent: true };
    throw error;
  }
  return { attached: true, idempotent: false };
}

const customerStatus = (row) => row.status === "REWARDED" ? "Reward earned" : row.status === "QUALIFYING" ? "Qualifying" : row.status === "DISQUALIFIED" ? "Not qualified" : "Signed up";

export async function getReferralDashboard(user, { appUrl, prismaClient = prisma }) {
  const code = await getOrCreateReferralCode(user, prismaClient);
  const rows = await prismaClient.referral.findMany({ where: { referrerUserId: user.id }, include: { reward: true }, orderBy: { attributedAt: "desc" }, take: 100 });
  return {
    code: code.code,
    referralLink: `${String(appUrl).replace(/\/$/, "")}/r/${code.code}`,
    rewardAmountCents: REFERRAL_REWARD_CENTS,
    currency: REFERRAL_CURRENCY,
    pendingAmountCents: rows.filter((row) => row.status === "QUALIFYING").length * REFERRAL_REWARD_CENTS,
    earnedAmountCents: rows.filter((row) => row.status === "REWARDED").length * REFERRAL_REWARD_CENTS,
    referrals: rows.map((row) => ({ id: row.id, status: customerStatus(row), attributedAt: row.attributedAt, qualifiesAt: row.qualifiesAt, rewardedAt: row.reward?.grantedAt ?? null })),
  };
}

async function resolveEventUserId(event, prismaClient, stripe) {
  const object = event.data?.object ?? {};
  const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id ?? (event.type.startsWith("customer.subscription.") ? object.id : null);
  if (subscriptionId) return (await prismaClient.subscription.findUnique({ where: { stripeSubscriptionId: subscriptionId }, select: { userId: true } }))?.userId ?? null;
  let customerId = typeof object.customer === "string" ? object.customer : object.customer?.id;
  if (!customerId && event.type === "charge.dispute.created" && object.charge) {
    const chargeId = typeof object.charge === "string" ? object.charge : object.charge.id;
    const charge = await (stripe ?? stripeClient()).charges.retrieve(chargeId);
    customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
  }
  return customerId ? (await prismaClient.subscription.findUnique({ where: { stripeCustomerId: customerId }, select: { userId: true } }))?.userId ?? null : null;
}

export async function handleReferralStripeEvent(event, { now = new Date(event.created ? event.created * 1000 : Date.now()), prismaClient = prisma, stripe } = {}) {
  const relevant = new Set(["invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted", "charge.refunded", "charge.dispute.created"]);
  if (!relevant.has(event.type)) return { ignored: true };
  if (!prismaClient.referral || !prismaClient.referralStripeEvent) return { ignored: true };
  const userId = await resolveEventUserId(event, prismaClient, stripe);
  if (!userId) return { ignored: true };
  const referral = await prismaClient.referral.findUnique({ where: { referredUserId: userId } });
  if (!referral || referral.status === "REWARDED" || referral.status === "DISQUALIFIED") return { ignored: true };
  const object = event.data.object;
  const disqualify = event.type !== "invoice.paid" && (event.type !== "customer.subscription.updated" || object.status !== "active" || object.cancel_at_period_end === true);
  try {
    return await prismaClient.$transaction(async (tx) => {
      await tx.referralStripeEvent.create({ data: { eventId: event.id, eventType: event.type, referralId: referral.id } });
      if (event.type === "invoice.paid") {
        const qualifiesAt = new Date(now.getTime() + QUALIFICATION_MS);
        await tx.referral.update({ where: { id: referral.id }, data: { status: "QUALIFYING", paidAt: referral.paidAt ?? now, qualifyingSince: referral.qualifyingSince ?? now, qualifiesAt: referral.qualifiesAt ?? qualifiesAt, stripeSubscriptionId: typeof object.subscription === "string" ? object.subscription : object.subscription?.id, stripeConversionEventId: referral.stripeConversionEventId ?? event.id } });
        return { qualifying: true };
      }
      if (disqualify) {
        await tx.referral.update({ where: { id: referral.id }, data: { status: "DISQUALIFIED", disqualifiedAt: now, disqualificationReason: event.type } });
        return { disqualified: true };
      }
      return { ignored: true };
    });
  } catch (error) {
    if (error?.code === "P2002") return { duplicate: true };
    throw error;
  }
}

function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) throw Object.assign(new Error("Stripe not configured"), { code: "STRIPE_NOT_CONFIGURED" });
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

export async function grantReferralReward(rewardId, { now = new Date(), prismaClient = prisma, stripe = stripeClient() } = {}) {
  const reward = await prismaClient.referralReward.findUnique({ where: { id: rewardId }, include: { referral: true } });
  if (!reward) throw Object.assign(new Error("Referral reward not found"), { code: "REWARD_NOT_FOUND" });
  if (reward.status === "GRANTED") return { granted: true, idempotent: true, reward };
  const referrer = await prismaClient.user.findUnique({ where: { id: reward.referral.referrerUserId } });
  if (!referrer) throw Object.assign(new Error("Referral owner not found"), { code: "REFERRER_NOT_FOUND" });
  let subscription = await prismaClient.subscription.findUnique({ where: { userId: referrer.id } });
  let customerId = subscription?.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create(
      { email: referrer.email, metadata: { userId: referrer.id, purpose: "referral-credit" } },
      { idempotencyKey: `referral-customer:${referrer.id}` },
    );
    customerId = customer.id;
    subscription = await prismaClient.subscription.upsert({
      where: { userId: referrer.id },
      create: { userId: referrer.id, stripeCustomerId: customerId },
      update: { stripeCustomerId: customerId },
    });
  }
  await prismaClient.referralReward.update({ where: { id: reward.id }, data: { status: "PROCESSING", stripeCustomerId: customerId, attemptCount: { increment: 1 }, lastAttemptAt: now, lastErrorCode: null } });
  try {
    const transaction = await stripe.customers.createBalanceTransaction(customerId, { amount: -REFERRAL_REWARD_CENTS, currency: REFERRAL_CURRENCY, description: "Squadpitch referral reward", metadata: { referralId: reward.referralId, rewardId: reward.id } }, { idempotencyKey: reward.idempotencyKey });
    const saved = await prismaClient.$transaction(async (tx) => {
      const row = await tx.referralReward.update({ where: { id: reward.id }, data: { status: "GRANTED", stripeBalanceTransactionId: transaction.id, grantedAt: now, lastErrorCode: null } });
      await tx.referral.update({ where: { id: reward.referralId }, data: { status: "REWARDED" } });
      return row;
    });
    return { granted: true, idempotent: false, reward: saved };
  } catch (error) {
    await prismaClient.referralReward.update({ where: { id: reward.id }, data: { status: "FAILED", lastErrorCode: error.code ?? "STRIPE_CREDIT_FAILED" } });
    throw error;
  }
}

export async function processDueReferralRewards({ now = new Date(), prismaClient = prisma, stripe } = {}) {
  const due = await prismaClient.referral.findMany({ where: { status: "QUALIFYING", qualifiesAt: { lte: now } }, take: 100 });
  const results = [];
  for (const referral of due) {
    const subscription = await prismaClient.subscription.findUnique({ where: { userId: referral.referredUserId } });
    if (!subscription?.stripeSubscriptionId || subscription.status !== "ACTIVE" || subscription.cancelAtPeriodEnd) {
      await prismaClient.referral.update({ where: { id: referral.id }, data: { status: "DISQUALIFIED", disqualifiedAt: now, disqualificationReason: "not_continuously_paid" } });
      results.push({ referralId: referral.id, status: "DISQUALIFIED" });
      continue;
    }
    const reward = await prismaClient.referralReward.upsert({ where: { referralId: referral.id }, create: { referralId: referral.id, idempotencyKey: `referral-credit:${referral.id}` }, update: {} });
    if (process.env.REFERRAL_REWARDS_ENABLED !== "true" && !stripe) { results.push({ referralId: referral.id, status: "PENDING_MANUAL_ENABLEMENT" }); continue; }
    try { await grantReferralReward(reward.id, { now, prismaClient, ...(stripe ? { stripe } : {}) }); results.push({ referralId: referral.id, status: "GRANTED" }); }
    catch (error) { results.push({ referralId: referral.id, status: "FAILED", code: error.code ?? "REWARD_FAILED" }); }
  }
  return results;
}

export async function listAdminReferrals(prismaClient = prisma) {
  const rows = await prismaClient.referral.findMany({ include: { reward: true, referralCode: true }, orderBy: { createdAt: "desc" }, take: 250 });
  const ids = [...new Set(rows.flatMap((row) => [row.referrerUserId, row.referredUserId]))];
  const users = await prismaClient.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, name: true } });
  const byId = new Map(users.map((user) => [user.id, user]));
  return rows.map((row) => ({ ...row, referrer: byId.get(row.referrerUserId) ?? null, referred: byId.get(row.referredUserId) ?? null }));
}
