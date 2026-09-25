#!/usr/bin/env bun
/**
 * Deposits a copy of the SPA's index where the Bun server will be able to read it.
 *
 * WHY THIS FILE EXISTS. Vite builds into `public/`, and `public/` is exactly what the
 * application rsync EXCLUDES: the deployment manifest, `deploy.json`, declares it as the
 * `publicDir`, the hosting platform deploys it separately and Caddy serves it without Bun
 * ever seeing it (see the exclusion read from the manifest in scripts/simulate-deploy.sh).
 * The service, on the other hand, receives `/`, `/machine/*`, `/job/*` and the other
 * application paths, because a SPA routes them on the client and Caddy has no fallback to
 * the index for a path that matches no file.
 *
 * So the server has to render the index itself, and it cannot read it out of a directory
 * that will not have travelled. `shell/index.html` is that copy: one file, produced at
 * build time, outside the `publicDir`, and carried by the rsync exactly as `engine/` is.
 *
 * The assets never come through here: `/assets/index-<hash>.js` is in none of the
 * manifest's routes, so Caddy serves them from the separately deployed `publicDir`, and
 * locally it is server.ts's `fetch` that serves them out of `public/`. One copy of the
 * index, no copy of the assets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "public", "index.html");
const TARGET_DIR = join(ROOT, "shell");
const TARGET = join(TARGET_DIR, "index.html");

if (!existsSync(SOURCE)) {
  throw new Error(
    "public/index.html is missing: `bun run web:build` produced nothing.\n" +
      "Without it the server has no index to render, and the whole application answers a blank page.",
  );
}

const html = readFileSync(SOURCE, "utf8");

// Checked rather than assumed. An index whose script is not the build's own - a
// `src/main.tsx` left by an interrupted `vite build`, a copy taken before Vite had
// rewritten the tags - deploys without an error and renders a blank page: the browser asks
// for a TypeScript module that nothing compiles any more.
if (!/<script[^>]+src="\/assets\/[^"]+\.js"/.test(html)) {
  throw new Error(
    "public/index.html references no bundle under /assets/: this is not the output of a\n" +
      "`vite build`, and deploying it would render a blank page.",
  );
}

mkdirSync(TARGET_DIR, { recursive: true });
writeFileSync(TARGET, html);

console.log(`shell/index.html written, ${html.length} bytes`);
