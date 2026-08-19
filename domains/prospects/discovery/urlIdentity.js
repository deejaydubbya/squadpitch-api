export function normalizePublicUrl(value) {
  try {
    const url = value instanceof URL ? new URL(value) : new URL(value);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase() || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function absoluteSameDomain(value, base) {
  try {
    const url = new URL(value, base);
    return url.hostname.toLowerCase() === new URL(base).hostname.toLowerCase() ? url.toString() : null;
  } catch {
    return null;
  }
}
