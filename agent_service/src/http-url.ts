import { isIP } from "node:net";

export const MAX_PUBLIC_HTTP_URL_LENGTH = 2_000;

export function normalizePublicHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (
    !candidate ||
    candidate.length > MAX_PUBLIC_HTTP_URL_LENGTH ||
    /[\u0000-\u0020\u007f]/.test(candidate)
  ) {
    return null;
  }

  if (candidate.startsWith("<") && candidate.endsWith(">")) {
    candidate = candidate.slice(1, -1);
  }

  if (!/^https?:\/\//i.test(candidate)) {
    const host = candidate.split(/[/?#]/, 1)[0]?.replace(/^www\./i, "") ?? "";
    const hostWithoutPort = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!hostWithoutPort.includes(".") && isIP(hostWithoutPort) === 0) return null;
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || !url.hostname) return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!hostname.includes(".") && isIP(hostname) === 0) return null;
    return url.toString();
  } catch {
    return null;
  }
}
