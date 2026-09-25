#!/usr/bin/env bun
/**
 * Copies the engine into engine/, so that the deployment's rsync carries it.
 *
 * The deployment sends one directory, the one holding its manifest, deploy.json. devbox,
 * its prelude, the profiles and the Terraform sources live at the root of this repository,
 * outside that directory, so they are copied in at build time rather than symlinked: rsync
 * would follow a symlink out of the tree or, worse, copy the link itself.
 *
 * This script ran a TypeScript port of the core through here for a day, under a manifest
 * that described the whole set and a digest over the whole tree. The port is gone and so is
 * the manifest; the engine is one bash file, its prelude, the profiles and the roots, which
 * is what it was before and what the version handshake hashes again.
 *
 * Two things are deliberately left behind:
 *
 *   terraform.tfstate*   the operator's own fleet. Shipping it would hand the server a
 *                        state describing machines it did not create and must not touch.
 *   .terraform/          provider binaries, built for darwin. The server runs Linux and
 *                        does its own `terraform init`.
 *
 * .terraform.lock.hcl, on the other hand, IS copied, and that is the whole point of
 * committing it: it is what makes the server resolve the same provider versions as the
 * Mac rather than whatever the registry offers on the day it initialises.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CLOUDS } from "../src/config";
import { rootNeeds } from "../src/roots";

const ROOT = join(import.meta.dir, "..", "..");
const ENGINE = join(import.meta.dir, "..", "engine");

function require_(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`missing from the repository root: ${path}`);
  }
  return path;
}

/**
 * A directory of the engine, traversable by whoever ends up running the service.
 *
 * mkdirSync's mode is masked by the umask of whoever runs the build, and that is not a
 * theoretical concern: a deployment script set `umask 077` to assemble its secrets and
 * called the hosting platform's deploy afterwards, which rebuilds here. The engine then
 * reached the server as drwx------ owned by the deploying account, the service ran under an
 * account of its own and could not traverse its own executor. Measured on 27/08: the
 * deployment ended green, GET / answered 200, and every attempt to order a machine died on
 * "engine/ is missing".
 *
 * chmod after the fact rather than a mode argument, because the umask applies to that too.
 * Nothing secret travels in engine/ - it is the core, the profiles and the .tf sources,
 * all of them already public in the repository.
 */
function engineDir(path: string): string {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o755);
  return path;
}

// Rebuilt whole. A stale profile left behind from a previous build would still be listed
// by `devbox profiles`, and would still be selectable in the form.
rmSync(ENGINE, { recursive: true, force: true });
engineDir(ENGINE);

// devbox-core, deposited as engine/devbox. The repository's `devbox` is a shell script that picks
// a renderer - Ink on Bun for a terminal, the core for everything else - and the server is
// "everything else" by definition: it spawns devbox with both streams piped, from a systemd
// unit, with nobody watching. Shipping the core directly is therefore not a shortcut but
// the honest thing: the service depends on the executor and on nothing else, and cli/
// never has to be installed on it.
cpSync(require_(join(ROOT, "devbox-core")), join(ENGINE, "devbox"));
chmodSync(join(ENGINE, "devbox"), 0o755);

// The copy is verbatim, asserted rather than trusted.
//
// The version handshake rests entirely on this: the workstation hashes devbox-core, the
// service hashes engine/devbox, and the two are compared. Let anything ever touch the file on
// the way through - a version banner, a path rewritten, a line ending normalised - and the
// two digests part forever. Every command would then warn about a gap right after a
// successful deployment, and an operator who learns to ignore the warning is back to the
// failure this whole mechanism exists to remove. Cheaper to fail the build here.
{
  const digest = (path: string) =>
    new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
  const source = digest(join(ROOT, "devbox-core"));
  const copy = digest(join(ENGINE, "devbox"));
  if (source !== copy) {
    throw new Error(
      `engine/devbox is not devbox-core byte for byte (${source.slice(0, 7)} vs ${copy.slice(0, 7)}).\n` +
        "The version handshake compares those two digests, so a copy that transforms the " +
        "file would warn about a gap after every successful deployment.",
    );
  }
}

engineDir(join(ENGINE, "profiles"));
for (const file of readdirSync(require_(join(ROOT, "profiles")))) {
  if (!file.endsWith(".sh")) continue;
  cpSync(join(ROOT, "profiles", file), join(ENGINE, "profiles", file));
}

// Every cloud the dashboard implements, and CLOUDS rather than clouds(): what ships is
// decided by the code, never by whether THIS workstation happens to hold a credential. A
// key deposited on the server after the deployment must find its root already there —
// it reaches $DEVBOX_SECRETS_DIR by a road that redeploys nothing.
const needs = rootNeeds(join(ROOT, "tf"));
for (const cloud of CLOUDS) {
  const from = require_(join(ROOT, "tf", cloud));
  const to = join(ENGINE, "tf", cloud);
  engineDir(join(ENGINE, "tf"));
  engineDir(to);
  // Plus whatever this root reads from its OWN directory, which is a second way out that
  // a filter on `.tf` silently drops. Nothing named here - src/roots.ts reads it off the
  // root itself.
  const sibling = needs.inside[cloud] ?? [];
  for (const file of readdirSync(from)) {
    if (file.endsWith(".tf") || file === ".terraform.lock.hcl" || sibling.includes(file)) {
      cpSync(join(from, file), join(to, file));
    }
  }
  for (const name of sibling) require_(join(to, name));
  const lock = join(to, ".terraform.lock.hcl");
  if (!existsSync(lock)) {
    console.warn(
      `/!\\ tf/${cloud} has no .terraform.lock.hcl: the server will resolve its own` +
        " provider versions.\n    terraform -chdir=tf/" +
        cloud +
        " providers lock -platform=darwin_arm64 -platform=linux_amd64",
    );
  } else if ((readFileSync(lock, "utf8").match(/^\s*"h1:/gm) ?? []).length < 2) {
    // A lock written by a plain `terraform init` on this Mac records ONE package hash, for
    // darwin_arm64. It is a perfectly valid lock and it makes the server's `terraform init`
    // refuse the provider it just downloaded, because linux_amd64's zip hashes against
    // nothing the file knows. Found on tf/gcp on 31/08, the day that root first became
    // something the dashboard would ship.
    //
    // Counted rather than named: the file records hashes, not platform names, and one h1
    // per platform is the whole of what terraform writes. Two is therefore the floor for a
    // root that has to initialise on a Mac and on a Debian.
    console.warn(
      `/!\\ tf/${cloud}/.terraform.lock.hcl records a single package hash, so it was` +
        " locked for this Mac alone: the server's `terraform init` will refuse the" +
        " provider.\n    terraform -chdir=tf/" +
        cloud +
        " providers lock -platform=darwin_arm64 -platform=linux_amd64",
    );
  }
}

// What every root reaches for two levels up - read off the roots that just shipped, never
// listed here. `require_` is the whole point: a file a root reads and this repository does
// not hold stops the BUILD, on this workstation, seconds after the edit that named it.
// Listed by hand, the same gap was found five days later, on a machine that could no
// longer be destroyed. See src/roots.ts.
const beside = rootNeeds(join(ENGINE, "tf")).beside;
for (const name of beside) {
  const source = join(ROOT, name);
  if (!existsSync(source)) {
    // Said with the reason, because the name alone sends someone looking for a typo. What
    // is actually wrong is that a root reads a file this repository does not have, and the
    // consequence is not a missing feature: terraform evaluates `file()` at PLAN time, so
    // every machine becomes both uncreatable and UNDESTROYABLE.
    throw new Error(
      `the terraform roots read ${name} and this repository does not hold it.\n` +
        `  A tf/<cloud>/*.tf reaches for it as \${path.module}/../../${name}, and terraform\n` +
        "  reads that at plan time: no machine could then be created OR destroyed.\n" +
        `  Either add ${name} beside devbox-core, or stop the root from reading it.`,
    );
  }
  const target = join(ENGINE, name);
  engineDir(dirname(target));
  cpSync(source, target);
}

// Asserted rather than trusted, like the digest above, and for a failure of the same
// shape: one nobody sees until a machine is ordered. A directory the service cannot
// traverse ships as happily as one it can, and the deployment ends green either way.
{
  const unreadable: string[] = [];
  const walk = (dir: string) => {
    if ((statSync(dir).mode & 0o755) !== 0o755) unreadable.push(dir.replace(`${ENGINE}/`, ""));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(ENGINE);
  if (unreadable.length > 0) {
    throw new Error(
      `engine/ holds ${unreadable.length} directory the service could not traverse: ` +
        `${unreadable.join(", ")}.\n` +
        "  The service runs as its own account and reads engine/ from a read-only bind\n" +
        "  mount. A mode of 700 there deploys fine, answers GET / fine, and fails on every\n" +
        "  attempt to order a machine with `engine/ is missing or incomplete`.",
    );
  }
}

const count = (dir: string) => readdirSync(dir).length;
console.log(
  `engine/ built: devbox, ${beside.length} files the roots read,` +
    ` ${count(join(ENGINE, "profiles"))} profiles, ${CLOUDS.length} terraform roots`,
);
