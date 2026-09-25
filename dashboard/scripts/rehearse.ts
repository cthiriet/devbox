#!/usr/bin/env bun
/**
 * The two checks scripts/simulate-deploy.sh runs INSIDE the rsynced copy, as a file tsc sees.
 *
 *   bun scripts/rehearse.ts roots    what the deployed roots read and engine/ does not hold
 *   bun scripts/rehearse.ts engine   the deployed service spawning its engine, its own way
 *
 * Both used to be TypeScript inlined in the shell script, where no typecheck reaches. Measured
 * on 11/09: engineEnv() had taken a launch since the vault, the inline call still passed
 * nothing, and `bun run verify` - the gate in front of every deployment - died on
 * `TypeError ... launch.unset` with `tsc --noEmit` and every test green. Here, a signature that
 * moves fails `bun run check`, which `verify` runs before the rehearsal.
 *
 * Run from the deployed copy: this file travels with the rsync (scripts/ is not among
 * deploy.json's exclusions), and its imports resolve against the copy's src/, not the
 * workstation's - which is the whole point of rehearsing on the copy.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_DIR } from "../src/config";

const mode = process.argv[2];

if (mode === "roots") {
  // Imported here and not at the top: this mode needs no database, and src/engine.ts opens one
  // under DATA_DIR the moment it is loaded.
  const { rootNeeds } = await import("../src/roots");
  const needs = rootNeeds(join(ENGINE_DIR, "tf"));
  const missing = needs.beside.filter((name) => !existsSync(join(ENGINE_DIR, name)));
  for (const [cloud, names] of Object.entries(needs.inside)) {
    for (const name of names) {
      if (!existsSync(join(ENGINE_DIR, "tf", cloud, name))) missing.push(`${cloud}/${name}`);
    }
  }
  // One line, empty when nothing is missing: the shell script reads it as a list of names.
  console.log(missing.join(" "));
} else if (mode === "engine") {
  // profiles() and not a Bun.spawn spelled here: it goes through run(), prepareLaunch and
  // engineEnv, which is the road every read of the service takes - a command line written in
  // this file would exercise none of them.
  const { prepareDirectories, profiles } = await import("../src/engine");
  const { accountTree, stageRoots } = await import("../src/tree");
  const { FOUNDING_ACCOUNT } = await import("../src/accounts");
  const { sourcesFor } = await import("../src/secrets");
  prepareDirectories();
  // The same two gestures the service makes on the way up, in the same order: the roots
  // staged once, then the account's tree - which copies them in, mints its key and renders its
  // profiles. Rehearsing the read without them would exercise a tree that has never been made.
  stageRoots();
  const paths = accountTree(FOUNDING_ACCOUNT);
  // An account has to be named, since every read takes one. `profiles` hands the child no
  // secret, so the one named reads nothing: no row of the vault is opened.
  const answered = await profiles(paths, sourcesFor({ id: FOUNDING_ACCOUNT, email: "rehearsal@localhost" }));
  if (answered.length === 0) throw new Error("devbox profiles --json answered an empty list");
  console.log(answered.map((profile) => profile.name).join(" "));
} else {
  process.stderr.write(`usage: bun scripts/rehearse.ts roots|engine (got ${JSON.stringify(mode)})\n`);
  process.exit(2);
}
