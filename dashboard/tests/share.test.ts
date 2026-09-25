import { describe, expect, test } from "bun:test";

import { decode, encode, shareLink } from "../web/src/lib/share";
import type { ProfileSpec } from "../web/src/lib/types";

/**
 * A profile as a link, and back.
 *
 * The one page-side module under this suite, because it is the one whose failure is silent on
 * both sides: an encoding that loses a character sends a colleague a profile that clones a
 * different URL, and a decoder that throws on a mangled link is a blank page in the hands of
 * someone who was only sent it. What the SERVER accepts is checkedSpec's business and is tested
 * with it; this is only whether the link carries the spec intact, and says "not a profile"
 * about anything else.
 */

const SPEC: ProfileSpec = {
  name: "stack",
  // Everything a URL may not hold, and a character outside Latin-1, which is where a naive
  // btoa() throws: a note is free text, and the link has to carry it whole.
  note: "alice@acme.test / dév-pass — see docs/#accounts & ?more=1",
  software: ["gh", "claude"],
  optional: ["github"],
  secrets: ["stack-gcp", "stack-openrouter"],
  repos: [
    { url: "https://github.com/acme/stack.git", secret: "github", dir: null },
    { url: "https://gitlab.example/acme/infra.git", secret: null, dir: "/workspace/infra" },
  ],
  setup: "scripts/devbox-setup.sh",
  cpu: 4,
  ram: 8,
  disk: 80,
  ports: [9010, 5173],
};

describe("the link", () => {
  test("carries the spec whole, across a round trip", () => {
    expect(decode(encode(SPEC))).toEqual(SPEC);
  });

  /**
   * base64url and nothing else: a `+` or a `/` in a fragment survives, but a `=` pasted into a
   * chat is where a client trims or escapes, and the whole point of the alphabet is that no
   * one has to think about it.
   */
  test("is made of characters a URL carries untouched", () => {
    expect(encode(SPEC)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("lands on the compose form, in the fragment", () => {
    const link = shareLink(SPEC, "https://devbox.example");
    expect(link.startsWith("https://devbox.example/profiles/new#import=")).toBe(true);
    // Never the query string, which the reverse proxy writes into its access log.
    expect(link).not.toContain("?");
  });

  /**
   * A value never rides in a spec - the type has no field for one - and the link is where that
   * would matter most, pasted into a chat. Asserted on the bytes, not the type.
   */
  test("names secrets, and holds nothing else about them", () => {
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(encode(SPEC).replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(Object.keys(SPEC).sort());
  });
});

describe("decode", () => {
  test("fills an absent field with its empty value", () => {
    const bare = encode({ name: "x" } as unknown as ProfileSpec);
    expect(decode(bare)).toEqual({
      name: "x",
      note: null,
      software: [],
      optional: [],
      secrets: [],
      repos: [],
      setup: null,
      cpu: null,
      ram: null,
      disk: null,
      ports: [],
    });
  });

  /**
   * A link made before 24/09 carries `port`, one number or null, and still opens the form it
   * was made from: links went to colleagues before the list existed.
   */
  test("reads the single port of a link made before the list", () => {
    const { ports: _ports, ...rest } = SPEC;
    expect(decode(encode({ ...rest, port: 9010 } as never))?.ports).toEqual([9010]);
    expect(decode(encode({ ...rest, port: null } as never))?.ports).toEqual([]);
  });

  test("answers null to anything that is not a spec, and never throws", () => {
    const wrong = (value: unknown) =>
      encode(value as ProfileSpec);
    for (const raw of [
      "",
      "not base64 at all!",
      "%%%",
      "A".repeat(20_000),
      wrong([1, 2, 3]),
      wrong("a string"),
      wrong({ name: "x", software: "gh" }),
      wrong({ name: "x", repos: [{ secret: "github" }] }),
      wrong({ name: "x", cpu: "4" }),
      // Not Infinity: JSON writes it as null, which is a valid port. A boolean is not.
      wrong({ name: "x", port: true }),
      wrong({ name: "x", ports: [9010, "5173"] }),
      wrong({ name: "x", ports: 9010 }),
    ]) {
      expect(decode(raw)).toBeNull();
    }
  });

  /** A truncated paste, the likeliest way a link breaks: it must say so rather than fill half. */
  test("refuses a link cut short", () => {
    const whole = encode(SPEC);
    expect(decode(whole.slice(0, Math.floor(whole.length / 2)))).toBeNull();
  });
});
