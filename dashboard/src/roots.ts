import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What the Terraform roots read, asked of the roots themselves.
 *
 * A root reaches outside its own directory. tf/<cloud>/main.tf holds
 * `file("${path.module}/../../prelude.sh")` and two more like it, so a root only works
 * when it sits in a repository-shaped layout - the files it names beside the tf/ that
 * holds it. Two places have to honour that: scripts/build-engine.ts, which assembles what
 * the deployment sends, and src/engine.ts, which lays a root out beside the state at
 * startup.
 *
 * BOTH USED TO CARRY THE LIST BY HAND, AND THAT IS THE BUG THIS FILE EXISTS TO END. The
 * list said two names on 26/08 and the roots wanted three: devbox-provision.sh had become a
 * file of its own five days earlier, when phase 1 came out of the cloud-init template, and
 * neither copier followed. `file()` is evaluated at PLAN time, so terraform then refused
 * everything - including `destroy`, which is the half that costs money. Measured that day
 * on a live cx33: created while the old roots were still in place, it became undestroyable
 * by the very service that had ordered it, the moment the new ones were synchronised over
 * them. A machine a dashboard cannot destroy keeps billing.
 *
 * So nothing is listed here. The names are READ OUT OF THE .tf FILES being copied, which
 * makes them impossible to forget: a root that starts reading a fourth file is a root
 * whose fourth file is carried, with no edit anywhere. And what cannot be found is named
 * loudly - see the callers - instead of failing three minutes into an apply.
 */
const REFERENCE = /\$\{path\.module\}\/([\w./-]+)/g;

export type RootNeeds = {
  /** Read two levels up: they belong beside the directory that holds tf/. */
  beside: string[];
  /** Read from the root's own directory, per cloud: they travel with it. */
  inside: Record<string, string[]>;
};

/** Reads `<tfDir>/<cloud>/*.tf`. An absent or unreadable directory needs nothing. */
export function rootNeeds(tfDir: string): RootNeeds {
  const beside = new Set<string>();
  const inside: Record<string, Set<string>> = {};
  if (!existsSync(tfDir)) return { beside: [], inside: {} };

  for (const cloud of readdirSync(tfDir)) {
    const directory = join(tfDir, cloud);
    if (!statSync(directory).isDirectory()) continue;

    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".tf")) continue;
      for (const [, reference] of readFileSync(join(directory, file), "utf8").matchAll(
        REFERENCE,
      )) {
        if (reference === undefined) continue;
        // `../../` and nothing else, because that is the only way out a root takes and a
        // deeper one would mean a layout nobody here can lay out. Anything else is a
        // sibling of the .tf itself.
        if (reference.startsWith("../../")) {
          const name = reference.slice("../../".length);
          if (!name.includes("..")) beside.add(name);
        } else if (!reference.includes("..")) {
          (inside[cloud] ??= new Set()).add(reference);
        }
      }
    }
  }

  return {
    beside: [...beside].sort(),
    inside: Object.fromEntries(
      Object.entries(inside).map(([cloud, names]) => [cloud, [...names].sort()]),
    ),
  };
}
