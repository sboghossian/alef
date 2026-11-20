// Request guard: this server can open Terminal and run `claude`, so only the
// local browser tab may drive it. Blocks LAN access (via listen host),
// DNS rebinding (Host check) and cross-site requests (Origin + JSON-only writes).

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export interface GuardInput {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
  /** The browser's Sec-Fetch-Site. Absent from curl and older browsers. */
  fetchSite?: string | undefined;
}

export interface GuardRejection {
  status: 403 | 415;
  error: string;
}

export function checkRequest(input: GuardInput): GuardRejection | null {
  if (!input.host || !LOOPBACK_HOST.test(input.host)) return { status: 403, error: "host not allowed" };
  if (input.origin !== undefined && !LOOPBACK_ORIGIN.test(input.origin)) return { status: 403, error: "origin not allowed" };
  // A simple cross-site GET (an <img> or <script> on any web page) carries no Origin, but the
  // browser marks it cross-site; refuse those too, so a page can't make /api/mac/* run osascript.
  if (input.fetchSite?.toLowerCase() === "cross-site") return { status: 403, error: "cross-site request refused" };
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    // A cross-site page can only send JSON after a CORS preflight, which this server never grants.
    const type = (input.contentType ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return { status: 415, error: "content-type must be application/json" };
  }
  return null;
}
