import { describe, expect, test } from "bun:test";
import { admission, checkedEmail, doors, EMAIL_MAX, foldedEmail } from "../src/accounts";

/**
 * What an account is made of, and which way in is open - decided here, with no database and
 * no server, which is why every row of the table in src/accounts.ts can be stated rather than
 * arranged. The rows matter more than the functions: each one is a state a real deployment
 * restarts in, and the wrong answer to any of them either locks an operator out of their own
 * service or hands account 1 to whoever signs in first.
 */

describe("checkedEmail", () => {
  test("accepts what a person would type", () => {
    for (const email of [
      "me@example.org",
      "first.last+tag@mail.example.co.uk",
      "a@b.cd",
      "élise@exemple.fr",
    ]) {
      expect(checkedEmail(email)).toEqual({ ok: true, value: email });
    }
  });

  test("trims, and keeps the address as typed for display", () => {
    expect(checkedEmail("  Me@Example.org \n")).toEqual({ ok: true, value: "Me@Example.org" });
  });

  test("refuses what is not an address", () => {
    for (const value of [
      "",
      "   ",
      "me",
      "me@",
      "@example.org",
      "me@example",
      "me@.org",
      "me@example.",
      "two@at@example.org",
      "me example@org.com",
      "me@exa mple.org",
      42,
      null,
      undefined,
      ["me@example.org"],
    ]) {
      expect(checkedEmail(value).ok, String(value)).toBe(false);
    }
  });

  test("refuses control characters, which render as nothing", () => {
    expect(checkedEmail("me\0@example.org").ok).toBe(false);
    expect(checkedEmail("me@example.org").ok).toBe(false);
  });

  test("refuses an address longer than a mail server would accept", () => {
    const long = `${"a".repeat(64)}@${"b".repeat(EMAIL_MAX)}.org`;
    expect(checkedEmail(long).ok).toBe(false);
    // The local part alone has its own ceiling, which is where RFC 5321 puts one.
    expect(checkedEmail(`${"a".repeat(65)}@example.org`).ok).toBe(false);
    expect(checkedEmail(`${"a".repeat(64)}@example.org`).ok).toBe(true);
  });

  test("checks the folded form too, so a fullwidth at-sign smuggles no second one in", () => {
    // NFKC turns U+FF20 into @. Valid as given, the folded form would carry two of them - and
    // the folded form is what is stored unique and what an identity links by.
    expect(checkedEmail("a＠b@example.org").ok).toBe(false);
    expect(checkedEmail("a＠example.org").ok).toBe(false);
  });
});

describe("foldedEmail", () => {
  test("is NFKC and lower case, so one visible address is one account", () => {
    expect(foldedEmail("Me@Example.ORG")).toBe("me@example.org");
    expect(
      foldedEmail("ＡＢＣ@ＥＸＡＭＰＬＥ.ＯＲＧ"),
    ).toBe("abc@example.org");
    expect(foldedEmail("ﬁrst@example.org")).toBe("first@example.org");
  });
});

describe("admission", () => {
  const NOW = Date.UTC(2026, 8, 15, 12);
  const MINUTE = 60_000;
  const founder = { email: "Founder@Example.com", folded: "founder@example.com", authoritative: true };
  const stranger = { email: "stranger@example.com", folded: "stranger@example.com", authoritative: true };
  /** The founder's address, from a provider that is not authoritative for it: Google outside Gmail and Workspace. */
  const unvouchedFounder = { ...founder, authoritative: false };
  const facts = (overrides: Partial<Parameters<typeof admission>[0]> = {}) => ({
    ever: false,
    createdLastHour: 0,
    oldestInHour: null,
    now: NOW,
    candidates: [stranger],
    founderFolded: founder.folded,
    cap: 30,
    ...overrides,
  });

  test("nothing ever existed, and a candidate is the founder's: account 1, under that candidate", () => {
    // Any candidate, not only the first: the founder's address may be a secondary verified one.
    expect(admission(facts({ candidates: [stranger, founder] }))).toEqual({ decision: "found", candidate: founder });
  });

  test("nothing ever existed, and no candidate is the founder's: nothing is created, whoever it is", () => {
    expect(admission(facts())).toEqual({ decision: "unfounded" });
    // No founder named: nothing opens at all, and "first to sign in" is exactly what is refused.
    expect(admission(facts({ founderFolded: "", candidates: [founder] }))).toEqual({ decision: "unfounded" });
  });

  test("the founder's address its provider does not vouch for founds nothing, and says why", () => {
    expect(admission(facts({ candidates: [unvouchedFounder] }))).toEqual({ decision: "unvouched" });
    // Beside an authoritative candidate of the same address, that one founds.
    expect(admission(facts({ candidates: [unvouchedFounder, founder] }))).toEqual({ decision: "found", candidate: founder });
    // A stranger that is not vouched for is simply not the founder.
    expect(admission(facts({ candidates: [{ ...stranger, authoritative: false }] }))).toEqual({ decision: "unfounded" });
  });

  test("an account has existed: an address its provider does not vouch for still creates, since nobody holds it", () => {
    const unvouched = { ...stranger, authoritative: false };
    expect(admission(facts({ ever: true, candidates: [unvouched] }))).toEqual({ decision: "create", candidate: unvouched });
  });

  test("the founding is never refused by the cap, which counts everyone after", () => {
    expect(admission(facts({ candidates: [founder], createdLastHour: 99, cap: 1 }))).toMatchObject({ decision: "found" });
  });

  test("an account has existed: a new one under the first candidate, and the founder's address means nothing more", () => {
    expect(admission(facts({ ever: true, candidates: [stranger, founder] }))).toEqual({ decision: "create", candidate: stranger });
    expect(admission(facts({ ever: true, candidates: [founder] }))).toEqual({ decision: "create", candidate: founder });
  });

  test("the hour's cap reached: busy, for as long as the oldest account of the hour stays in it", () => {
    expect(admission(facts({ ever: true, createdLastHour: 30, oldestInHour: NOW - 20 * MINUTE }))).toEqual({
      decision: "busy",
      minutes: 40,
    });
    // Rounded up, and never "0 min".
    expect(admission(facts({ ever: true, createdLastHour: 2, cap: 2, oldestInHour: NOW - 60 * MINUTE + 1 }))).toEqual({
      decision: "busy",
      minutes: 1,
    });
    expect(admission(facts({ ever: true, createdLastHour: 1, cap: 2, oldestInHour: NOW }))).toMatchObject({ decision: "create" });
  });

  test("an identity with no candidate never reaches it", () => {
    expect(() => admission(facts({ candidates: [] }))).toThrow();
  });
});

describe("doors", () => {
  const BOTH = ["google", "github"] as const;
  const FOUNDER = "founder@example.com";

  test("no provider: nothing opens, whatever else holds, and no founding is promised", () => {
    // A claim with no provider would answer a token 503 for a founding nothing can perform.
    for (const accounts of [false, true]) {
      for (const founderEmail of ["", FOUNDER]) {
        expect(doors({ accounts, founderEmail, providers: [] })).toEqual({ claim: false, providers: [], closed: "no-provider" });
      }
    }
  });

  test("providers, no account ever, a founder named: the founding is ahead, and nothing is closed", () => {
    expect(doors({ accounts: false, founderEmail: FOUNDER, providers: BOTH })).toEqual({
      claim: true,
      providers: ["google", "github"],
      closed: null,
    });
    expect(doors({ accounts: false, founderEmail: FOUNDER, providers: ["github"] })).toMatchObject({ claim: true, providers: ["github"] });
  });

  test("providers, no account ever, no founder: closed, since first-come is exactly what is refused", () => {
    expect(doors({ accounts: false, founderEmail: "", providers: BOTH })).toEqual({
      claim: false,
      providers: ["google", "github"],
      closed: "no-founder",
    });
  });

  test("an account has existed: everyone signs in, and the founder's address is ignored", () => {
    for (const founderEmail of ["", FOUNDER]) {
      expect(doors({ accounts: true, founderEmail, providers: BOTH })).toEqual({
        claim: false,
        providers: ["google", "github"],
        closed: null,
      });
    }
  });
});
