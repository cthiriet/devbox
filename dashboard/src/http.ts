import { join, normalize } from "node:path";

/**
 * Cache lifetime per kind of resource.
 *
 * One policy, valid everywhere: the local server must behave like Caddy online, or a
 * caching defect only surfaces after a deployment. These three rules are the ones the
 * reverse proxy applies to every site it serves, and tests/cache.test.ts fails if this side
 * ever drifts from them.
 *
 * The SPA's shell does come through this function, and deliberately: server.ts reads that
 * file from shell/ rather than from public/, but it asks this for the header, so the one
 * page a browser navigates to is cached exactly as Caddy would cache it - revalidated every
 * time, which is what makes a deployment show on the next navigation.
 *
 * What never comes through here is the API. Every JSON answer carries `no-store` from
 * server.ts, because it describes a session, a fleet or a job in flight, and a cached one
 * would show a machine that no longer exists.
 */
export function cacheControl(pathname: string): string {
  if (pathname.endsWith(".html") || pathname === "/") {
    return "public, max-age=0, must-revalidate";
  }
  if (/\.(jpg|jpeg|png|webp|avif|svg|ico|woff2?)$/.test(pathname)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

/**
 * Resolves a public URL into a disk path, refusing anything that leaves `public/`
 * (`..`, absolute paths, encoded sequences).
 */
export function resolveAsset(pathname: string, root: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes(String.fromCharCode(0))) return null;

  const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = join(root, relative);
  return resolved.startsWith(root) ? resolved : null;
}
