import { readFile } from "node:fs/promises";

const EXECUTION_FILES = [
  new URL("./index.js", import.meta.url),
  new URL("./reconcile.js", import.meta.url),
];

const FORBIDDEN = [
  /\.customers\.(?:create|update|del)\s*\(/,
  /\.subscriptions\.(?:create|update|cancel|del)\s*\(/,
  /\.checkout\.sessions\.create\s*\(/,
  /\.billingPortal\.sessions\.create\s*\(/,
  /\.paymentIntents\.(?:create|confirm|update)\s*\(/,
  /\.refunds\.create\s*\(/,
  /\.charges\.create\s*\(/,
  /\.invoices\.(?:create|update|del|finalizeInvoice|pay|sendInvoice|voidInvoice|markUncollectible)\s*\(/,
  /\bprisma\.[\w$]+\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/,
];

export function assertReadOnlySource(source) {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(source))
      throw new Error(
        "Reconciliation execution path contains a forbidden mutation",
      );
  }
}

export async function assertStaticReadOnlyPath() {
  for (const file of EXECUTION_FILES)
    assertReadOnlySource(await readFile(file, "utf8"));
}
