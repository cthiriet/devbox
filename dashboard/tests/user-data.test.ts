import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The user-data every root renders from cloud-init.yaml.tftpl, and the ceiling it lives under.
 *
 * Hetzner refuses a user_data over 32768 bytes, and says so only when the server is created:
 * the plan passes, the firewall is made, and the order dies. Measured on 17/09, when the
 * prelude had grown from 11 to 31 KB with the recipes: the template rendered to 50687 bytes
 * in plain base64, and every Hetzner order failed at apply, whatever the profile. Nothing had
 * said so before a machine was ordered, which is what this file is for.
 *
 * The cure is gzip under the base64, and it comes with a second way to break: a root that
 * still says base64encode() under a template that says `gz+b64` boots a machine whose
 * cloud-init cannot inflate the prelude. The two are pinned together below.
 */

const REPO = join(import.meta.dir, "..", "..");
const TEMPLATE = readFileSync(join(REPO, "cloud-init.yaml.tftpl"), "utf8");
const HETZNER_CEILING = 32768;

/** Each root that renders the template, with the text of its .tf files. */
function renderingRoots(): Array<{ root: string; source: string }> {
  const tf = join(REPO, "tf");
  return readdirSync(tf, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      root: entry.name,
      source: readdirSync(join(tf, entry.name))
        .filter((name) => name.endsWith(".tf"))
        .map((name) => readFileSync(join(tf, entry.name, name), "utf8"))
        .join("\n"),
    }))
    .filter(({ source }) => source.includes("cloud-init.yaml.tftpl"));
}

/** `name = function(file(".../<file>"))`, as each root passes a deposit to the template. */
function deposits(source: string): Array<{ name: string; fn: string; file: string }> {
  const found = source.matchAll(/(\w+_b64)\s*=\s*(\w+)\(file\("\$\{path\.module\}\/\.\.\/\.\.\/([^"]+)"\)\)/g);
  return [...found].map(([, name, fn, file]) => ({ name: name!, fn: fn!, file: file! }));
}

/** What terraform's function makes of the file, Bun's gzip standing in for Go's. */
function encoded(fn: string, file: string): string {
  const bytes = readFileSync(join(REPO, file));
  if (fn === "base64gzip") return Buffer.from(Bun.gzipSync(bytes)).toString("base64");
  if (fn === "base64encode") return bytes.toString("base64");
  throw new Error(`no stand-in for ${fn}()`);
}

describe("the cloud-init user-data", () => {
  test("every root that renders it is found, so the checks below are not vacuous", () => {
    expect(renderingRoots().map(({ root }) => root).sort()).toEqual(["gcp", "hetzner", "scaleway"]);
  });

  test("every deposit in the template is gzip under base64", () => {
    const encodings = [...TEMPLATE.matchAll(/encoding:\s*(\S+)\s*\n\s*content:\s*\$\{(\w+)\}/g)];
    expect(encodings.map(([, , name]) => name).sort()).toEqual(["prelude_b64", "provision_b64"]);
    for (const [, encoding] of encodings) expect(encoding).toBe("gz+b64");
  });

  test("every root gzips what the template inflates", () => {
    for (const { root, source } of renderingRoots()) {
      const passed = deposits(source);
      expect({ root, names: passed.map(({ name }) => name).sort() }).toEqual({
        root,
        names: ["prelude_b64", "provision_b64"],
      });
      for (const { name, fn } of passed) expect({ root, name, fn }).toEqual({ root, name, fn: "base64gzip" });
    }
  });

  /**
   * Rendered the way templatefile() would, with what each root really passes: Bun's gzip and
   * Go's came within a few bytes of each other on the 17/09 files. The key is an RSA 4096
   * one's length, the longest a `$KEY.pub` is likely to be, where the dashboard's ed25519 is
   * under a hundred bytes. `$${` is left unescaped, which only overstates.
   *
   * Every root and not Hetzner's alone: the template is one, and a ceiling that holds for
   * the strictest provider holds for the others.
   */
  test("renders under Hetzner's ceiling, with room to spare", () => {
    for (const { root, source } of renderingRoots()) {
      let rendered = TEMPLATE.replace("${ssh_public_key}", `ssh-rsa ${"A".repeat(716)} devbox-1`);
      for (const { name, fn, file } of deposits(source)) {
        rendered = rendered.replace(`\${${name}}`, encoded(fn, file));
      }
      const size = Buffer.byteLength(rendered);

      // A margin under the ceiling: Go's gzip is not zlib's to the byte, and a test that goes
      // red at the last kilobyte leaves no time to decide what to move out.
      expect({ root, fits: size < HETZNER_CEILING - 2048, size }).toEqual({ root, fits: true, size });
    }
  });
});
