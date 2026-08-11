import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://api.rentcast.io/v1";
const SAFE_LANDMARK = "1600 Pennsylvania Avenue NW, Washington, DC 20500";

export async function verifyRentCast({
  apiKey = process.env.RENTCAST_API_KEY,
  baseUrl = process.env.RENTCAST_API_BASE ?? DEFAULT_BASE_URL,
  address = SAFE_LANDMARK,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error("RENTCAST_API_KEY is not configured");
  if (baseUrl !== DEFAULT_BASE_URL)
    throw new Error(
      "RentCast verification requires the production API base URL",
    );
  const url = new URL(`${baseUrl}/properties`);
  url.searchParams.set("address", address);
  const response = await fetchImpl(url, {
    headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `RentCast verification failed with HTTP ${response.status}`,
    );
  const payload = await response.json();
  const record = Array.isArray(payload) ? payload[0] : payload;
  const schemaValid = Boolean(
    record &&
    typeof record === "object" &&
    (record.formattedAddress || record.addressLine1 || record.id),
  );
  if (!schemaValid)
    throw new Error(
      "RentCast response did not match the expected property shape",
    );
  return {
    provider: "rentcast",
    status: "PASS",
    productionBase: true,
    schemaValid: true,
    requestsMade: 1,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await verifyRentCast(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        provider: "rentcast",
        status: "BLOCKED",
        reason: error.message,
      }),
    );
    process.exitCode = 1;
  }
}
