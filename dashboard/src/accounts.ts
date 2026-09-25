/**
 * What an account is made of, and when one may be opened. Decides, opens nothing: the queries
 * are src/db.ts, the routes server.ts, and the providers' answers src/oauth.ts.
 */
import type { Provider } from "./oauth";
import type { Checked } from "./validate";

export { FOUNDING_ACCOUNT, type Account } from "./schema";

/** RFC 5321's limit on a path, which is the longest address a mail server would accept. */
export const EMAIL_MAX = 254;

/**
 * A plausible address, and no more than that. A provider verified that its owner reads mail
 * there; what is left to keep out is what could never be an address here - spaces, a second `@`
 * in the folded form - before it is stored as an account's and looked up by folding.
 */
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/u;

/** Every control character, C0, DEL and C1 alike: they render as nothing. */
const CONTROL = /\p{Cc}/u;

/**
 * What is looked up and what is unique: NFKC, then lower case.
 *
 * NFKC because the same address can be written in more than one way that reads the same - a
 * fullwidth letter, a ligature - and two accounts under one visible address would be one person
 * locked out of the other. Lower case because nobody expects `Me@` and `me@` to be two people.
 * It folds more than a mail server would, and since 15/09 that is also what links: a verified
 * address folding to an account's opens that account. The safe direction still - a provider
 * verified the address, and case is not something two different people's mailboxes differ by.
 */
export function foldedEmail(email: string): string {
  return email.normalize("NFKC").toLowerCase();
}

/**
 * An address as a provider sent it: trimmed, and returned as spelled, for display.
 *
 * Checked twice, as given and as folded. NFKC turns a fullwidth `＠` into `@`, so an address
 * valid as given could fold into one with two of them, or into something longer than the
 * limit: the folded form is what is stored as unique and what an identity links by, and it is
 * the one that has to be an address.
 */
export function checkedEmail(value: unknown): Checked<string> {
  const field = "email";
  if (typeof value !== "string") return { ok: false, field, reason: "expected a string" };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, field, reason: "empty" };
  const folded = foldedEmail(trimmed);
  if (trimmed.length > EMAIL_MAX || folded.length > EMAIL_MAX) {
    return { ok: false, field, reason: `longer than ${EMAIL_MAX} characters` };
  }
  if (CONTROL.test(trimmed)) return { ok: false, field, reason: "control characters" };
  if (!EMAIL.test(trimmed) || !EMAIL.test(folded)) {
    return { ok: false, field, reason: "expected an address like name@example.org" };
  }
  return { ok: true, value: trimmed };
}

/** Long enough to say what a token is for - "CI, the deploy job" - and short enough for a row. */
export const TOKEN_LABEL_MAX = 64;

/**
 * What a CLI token is called on /account. Required, because the list is read months later to
 * decide which one can go, and a row with no name answers nothing: the label and the hour it
 * was last used are all that list ever shows of a token.
 */
export function checkedTokenLabel(value: unknown): Checked<string> {
  const field = "label";
  if (typeof value !== "string") return { ok: false, field, reason: "expected a string" };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, field, reason: "empty: say what this token is for" };
  if (trimmed.length > TOKEN_LABEL_MAX) {
    return { ok: false, field, reason: `longer than ${TOKEN_LABEL_MAX} characters` };
  }
  if (CONTROL.test(trimmed)) return { ok: false, field, reason: "control characters" };
  return { ok: true, value: trimmed };
}

/* --- who a verified identity becomes -------------------------------------------- */

/**
 * An address a provider verified, as it spelled it and as it folds, and whether the provider is
 * authoritative for it (VerifiedEmail in src/oauth.ts). One that is not can create an account
 * under an address nobody holds, and do nothing else: never link, never found.
 */
export type Candidate = { email: string; folded: string; authoritative: boolean };

/** The window DEVBOX_MAX_NEW_ACCOUNTS_PER_HOUR counts in. */
export const NEW_ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

/** What signInWith in src/db.ts has read, inside its transaction, before anything is created. */
export type AdmissionFacts = {
  /** Whether an account has EVER existed: src/db.ts#accountsExist, sqlite_sequence included. */
  ever: boolean;
  /** Accounts created in the last hour, account 1 never among them. */
  createdLastHour: number;
  /** When the oldest of those was created: what the wait is counted from. */
  oldestInHour: number | null;
  now: number;
  /** The identity's verified addresses, checked and folded, in the order they are tried. */
  candidates: readonly Candidate[];
};

export type Admission =
  | { decision: "found"; candidate: Candidate }
  | { decision: "create"; candidate: Candidate }
  | { decision: "unfounded" }
  | { decision: "unvouched" }
  | { decision: "busy"; minutes: number };

/**
 * What an identity nobody knows, and that links to no account, becomes. Pure: the facts are read
 * by the transaction that acts on the answer.
 *
 *   ever  candidates                         what happens
 *   no    an authoritative one is the         account 1: that address, that identity, the service
 *         founder's
 *   no    only one the provider does not      unvouched: nothing is created, and the page says to
 *         vouch for is the founder's          sign in where the address is vouched for
 *   no    none is, or none is named           unfounded: nothing is created, whoever it is
 *   yes   -, the hour's cap reached           busy, with the minutes until the oldest leaves the hour
 *   yes   -                                   a new account, under the first candidate
 *
 * THE FOUNDER IS NAMED, NOT FIRST. Account 1 alone is handed the service's own credentials, the
 * files of its secrets directory and, on a migrated deployment, a fleet - and a fresh hostname
 * shows up in Certificate Transparency logs within minutes of its certificate, from a repository
 * anyone can read. "First to sign in" would be a race against every scanner that reads those logs.
 * An address is compared rather than stored, so a typo in DEVBOX_FOUNDER_EMAIL is corrected by
 * fixing the variable and restarting: nothing has been founded under it.
 *
 * The founder's address counts only where the provider is AUTHORITATIVE for it: a Google address
 * outside Gmail and Workspace may be verified on a mailbox that changed hands, and account 1 is
 * the last account to hand to whoever holds it now. A creation takes any candidate, since by then
 * no account holds any of them (signInOn refuses `unvouched` first).
 *
 * The cap counts creations only: an identity already known, or one that links to an account,
 * never reaches this function, and the founding is never counted - it happens once.
 */
export function admission(input: AdmissionFacts & { founderFolded: string; cap: number }): Admission {
  const first = input.candidates[0];
  if (first === undefined) throw new Error("an identity with no candidate address reached admission");

  if (!input.ever) {
    const named = input.founderFolded === "" ? [] : input.candidates.filter((one) => one.folded === input.founderFolded);
    const founder = named.find((one) => one.authoritative);
    if (founder !== undefined) return { decision: "found", candidate: founder };
    return named.length > 0 ? { decision: "unvouched" } : { decision: "unfounded" };
  }

  if (input.createdLastHour >= input.cap) {
    const leaves = (input.oldestInHour ?? input.now) + NEW_ACCOUNT_WINDOW_MS - input.now;
    return { decision: "busy", minutes: Math.max(1, Math.ceil(leaves / 60_000)) };
  }

  return { decision: "create", candidate: first };
}

/* --- which ways in are open ------------------------------------------------------ */

export type Doors = {
  /**
   * No account has ever existed, DEVBOX_FOUNDER_EMAIL names one, and a provider can sign it in: the
   * next sign-in with that verified address founds account 1, and every other is refused. A bearer
   * token gets 503. Without a provider nothing can found anything, and nothing says it will.
   */
  claim: boolean;
  /** The providers this process signs in with. */
  providers: Provider[];
  /** Why no session can be opened at all, or null. */
  closed: null | "no-provider" | "no-founder";
};

/**
 * The states a service can restart in, and what each one opens.
 *
 *   providers  ever an account  DEVBOX_FOUNDER_EMAIL  what opens
 *   none       any              any                   nothing: closed "no-provider", and no claim
 *                                                     even with a founder named - a token is a
 *                                                     plain 401 then, not a 503 promising a
 *                                                     founding nothing can perform. CLI tokens of
 *                                                     existing accounts still answer, open sessions
 *                                                     too.
 *   some       no               set                   the founding: an identity with an address its
 *                                                     provider vouches for folding to it becomes
 *                                                     account 1; every other identity is refused
 *                                                     (it would draw id 1), and a token gets 503
 *   some       no               unset                 nothing: closed "no-founder"; a token is a
 *                                                     plain 401, being nobody's
 *   some       yes              ignored, and warned   everyone: a known identity, a link by
 *                                                     verified address, or a new account under
 *                                                     the hourly cap
 *
 * `accounts` means "ever", as src/db.ts#accountsExist answers it: deleting every account does
 * not bring the founding back.
 */
export function doors(input: { accounts: boolean; founderEmail: string; providers: readonly Provider[] }): Doors {
  const claim = !input.accounts && input.founderEmail !== "" && input.providers.length > 0;
  const closed =
    input.providers.length === 0 ? "no-provider" : !input.accounts && input.founderEmail === "" ? "no-founder" : null;
  return { claim, providers: [...input.providers], closed };
}
