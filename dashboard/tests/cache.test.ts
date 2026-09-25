import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cacheControl, resolveAsset } from "../src/http";

describe("cacheControl", () => {
  /**
   * These three rules are the ones the reverse proxy applies to every site it serves in
   * production. The local server must behave like Caddy online, or a caching defect only
   * surfaces after a deployment, on the machine that serves every client.
   */
  test("revalidates HTML on every request", () => {
    expect(cacheControl("/index.html")).toBe("public, max-age=0, must-revalidate");
    expect(cacheControl("/")).toBe("public, max-age=0, must-revalidate");
  });

  test("caches fingerprinted media for a year", () => {
    for (const path of ["/a.png", "/a.jpg", "/a.jpeg", "/a.webp", "/a.avif", "/a.svg", "/a.ico"]) {
      expect(cacheControl(path)).toBe("public, max-age=31536000, immutable");
    }
    expect(cacheControl("/font.woff2")).toBe("public, max-age=31536000, immutable");
  });

  test("gives everything else an hour", () => {
    // The bundle Vite deposits in public/ is fingerprinted and could be kept far longer,
    // but the rule is Caddy's and Caddy reads a path, not a build manifest. An hour is the
    // compromise the whole platform runs on: long enough to matter, short enough that a
    // deployment shows.
    expect(cacheControl("/assets/index-B3xK9a.js")).toBe("public, max-age=3600");
    expect(cacheControl("/assets/index-9fQ2wz.css")).toBe("public, max-age=3600");
  });

  test("keeps the SPA's shell revalidated, which is what makes a deployment show", () => {
    // This one page DOES come through here now: server.ts reads index.html from shell/ and
    // asks this function for its header. It names the fingerprinted bundle, so a shell
    // cached as immutable would pin an old application on a phone until someone cleared
    // the browser - the deployment would succeed and change nothing anyone could see.
    expect(cacheControl("/index.html")).toBe("public, max-age=0, must-revalidate");
    expect(cacheControl("/index.html")).not.toContain("immutable");
  });
});

describe("resolveAsset", () => {
  const root = "/srv/sites/devbox/public";

  test("resolves an ordinary path inside the root", () => {
    expect(resolveAsset("/styles.css", root)).toBe(join(root, "styles.css"));
  });

  test("neutralises a climb rather than following it", () => {
    // The climb is stripped, not refused: the result stays under the root and simply
    // names a file that does not exist. What matters is the invariant, and it is the
    // only thing asserted here: a path that ends in /etc/passwd UNDER the root is a
    // 404, while the same path outside it is the whole attack.
    for (const path of ["/../../etc/passwd", "/../secrets", "/a/../../../etc/shadow"]) {
      const resolved = resolveAsset(path, root);
      expect(resolved).not.toBeNull();
      expect(resolved?.startsWith(`${root}/`)).toBe(true);
    }
    expect(resolveAsset("/../../etc/passwd", root)).not.toBe("/etc/passwd");
  });

  test("neutralises an encoded climb too", () => {
    // %2e%2e%2f is `../`. Decoding happens before normalising for exactly this reason:
    // normalising first would leave the encoded form intact and let it through.
    const resolved = resolveAsset("/%2e%2e%2f%2e%2e%2fetc%2fpasswd", root);
    expect(resolved?.startsWith(`${root}/`)).toBe(true);
    expect(resolved).not.toBe("/etc/passwd");
  });

  test("refuses a malformed escape rather than throwing", () => {
    expect(resolveAsset("/%", root)).toBeNull();
  });

  test("refuses an embedded NUL", () => {
    expect(resolveAsset(`/styles.css${String.fromCharCode(0)}.png`, root)).toBeNull();
  });
});
