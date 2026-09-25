import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootNeeds } from "../src/roots";

/**
 * The reading of the roots, on its own.
 *
 * What this replaces is a list held by hand in two files, which said two names when the
 * roots wanted three and made a live machine impossible to destroy. A reader is only worth
 * more than a list if it reads correctly, which is what is pinned here.
 */

function rootsHolding(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "devbox-roots-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(directory, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return directory;
}

describe("rootNeeds", () => {
  test("reads both shapes: two levels up, and beside the .tf itself", () => {
    const tf = rootsHolding({
      "hetzner/main.tf": [
        'user_data = templatefile("${path.module}/../../cloud-init.yaml.tftpl", {',
        '  prelude_b64   = base64encode(file("${path.module}/../../prelude.sh"))',
        '  provision_b64 = base64encode(file("${path.module}/../../devbox-provision.sh"))',
        "})",
      ].join("\n"),
      "acme/main.tf": 'program = [abspath("${path.module}/machine.sh"), "inspect"]',
    });

    expect(rootNeeds(tf)).toEqual({
      beside: ["cloud-init.yaml.tftpl", "devbox-provision.sh", "prelude.sh"],
      inside: { acme: ["machine.sh"] },
    });
  });

  test("says the same name once, however many roots read it", () => {
    const tf = rootsHolding({
      "hetzner/main.tf": 'a = file("${path.module}/../../prelude.sh")',
      "scaleway/main.tf": 'b = file("${path.module}/../../prelude.sh")',
      "scaleway/extra.tf": 'c = file("${path.module}/../../prelude.sh")',
    });
    expect(rootNeeds(tf).beside).toEqual(["prelude.sh"]);
  });

  /**
   * A path that keeps climbing is refused rather than resolved. `../../` is the only way
   * out a root here takes - it is what puts it in a repository-shaped layout - and a
   * deeper one would name something outside the tree the deployment carries, which no
   * copier could honour. Silence would then be a promise nobody keeps.
   */
  test("refuses a reference that climbs further than the base", () => {
    const tf = rootsHolding({
      "hetzner/main.tf": [
        'a = file("${path.module}/../../../escape.sh")',
        'b = file("${path.module}/../sideways.sh")',
        'c = file("${path.module}/../../real.sh")',
      ].join("\n"),
    });
    expect(rootNeeds(tf)).toEqual({ beside: ["real.sh"], inside: {} });
  });

  test("reads .tf files and nothing else", () => {
    // A README quoting the interpolation, a lock file, a leftover .tf.bak: none of them is
    // configuration terraform evaluates.
    const tf = rootsHolding({
      "hetzner/main.tf": 'a = file("${path.module}/../../real.sh")',
      "hetzner/README.md": 'once read ${path.module}/../../legend.sh',
      "hetzner/main.tf.bak": 'a = file("${path.module}/../../old.sh")',
    });
    expect(rootNeeds(tf).beside).toEqual(["real.sh"]);
  });

  test("needs nothing from a directory that does not exist", () => {
    expect(rootNeeds(join(tmpdir(), "devbox-roots-absent-on-purpose"))).toEqual({
      beside: [],
      inside: {},
    });
  });
});
