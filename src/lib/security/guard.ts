import type { RateLimiter } from "./rateLimit";

/**
 * True when a browser on another site sent this request.
 *
 * Browsers attach `Origin` to every cross-origin POST and cannot forge it, so a
 * mismatch is proof the caller is someone else's page trying to spend this
 * app's OpenAI quota through a visitor's browser. An absent header means a
 * non-browser client -- curl, a script -- which could set any header it liked,
 * so refusing it would block the README's diagnostic probes while stopping no
 * one. Those clients are the rate limiter's job instead.
 */
export function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // `Origin: null` comes from sandboxed iframes and file:// pages. Never ours.
    return true;
  }

  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host;
  return originHost !== host;
}

/**
 * The address to rate-limit by.
 *
 * On Vercel both headers are set by the platform and overwrite anything the
 * client sent. Elsewhere they can be spoofed, which only matters for a public
 * deployment, and that deployment is Vercel.
 */
export function clientAddress(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

/**
 * Applies the origin check and, if given, a rate limit.
 *
 * Returns the refusal to send, or undefined when the request may proceed. The
 * origin check runs first so a cross-site page cannot use up a visitor's
 * allowance.
 */
export function guardRequest(request: Request, limiter?: RateLimiter): Response | undefined {
  if (isCrossOrigin(request)) {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  if (limiter) {
    const { allowed, retryAfterSeconds } = limiter.check(clientAddress(request));
    if (!allowed) {
      return Response.json(
        { error: `Too many requests. Try again in ${describeWait(retryAfterSeconds)}.` },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }
  }

  return undefined;
}

function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
