import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";

/**
 * What no runtime test can prove: that nothing reads one account's rows on behalf of another.
 *
 * The isolation tests exercise the routes they name. A route added next month that forgets the
 * account would pass all of them - and would answer, for whoever asked, with whatever the first
 * account holds. The compiler catches most of it: no default Sources, no path constant, a query
 * that asks for its account. What is left is a handful of shapes a type cannot refuse, and this
 * file reads the sources, as tests/undumpable.test.ts does, and fails on each of them:
 *
 *   OWNER_SELF, current()      the constant and the function that made every read account 1's.
 *                              DELETED rather than made to throw: a name like that goes on
 *                              attracting callers.
 *   a default Sources          `sources: Sources = ...`, the road by which account 2's order was
 *                              handed account 1's token.
 *   sourcesOf(                 the constructor that states a Sources outright, for a test or the
 *                              startup: anywhere else it is a Sources nobody derived from an
 *                              account. Tests may use it; production has src/secrets.ts alone.
 *   owner: 1                   the founder written as a number. FOUNDING_ACCOUNT names it.
 *   a statement on jobs, labels, profiles or machine_origins without account_id, in src/db.ts -
 *                              the only file allowed to hold one, schema.ts's declarations and
 *                              steps aside.
 *                              interruptRunning, the startup sweep, is the one exception, named.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const DASHBOARD = join(import.meta.dir, "..");

type Source = { path: string; text: string; scan: Scan };

/** A literal in the source: where it starts and ends, and what it holds. */
type Literal = { start: number; end: number; value: string };

/**
 * The source with comments and literal contents blanked to spaces - positions kept, so an index
 * found in one is an index in the other - and the literals, apart.
 *
 * A tokenizer rather than regular expressions over the raw text, because both kinds of false
 * answer are easy to get otherwise: `OWNER_SELF` in a comment explaining that it is gone would
 * fail the test, and a statement split over `"..." + "..."` would hide its account_id from a
 * pattern looking for one string.
 */
type Scan = { code: string; literals: Literal[] };

function scan(text: string): Scan {
  const out = text.split("");
  const literals: Literal[] = [];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  /** The last significant character of code, which says whether a `/` starts a regex. */
  let previous = "";

  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";

    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < text.length) {
        const d = text[j] ?? "";
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (c === "`" && d === "$" && text[j + 1] === "{") {
          depth += 1;
          j += 2;
          continue;
        }
        if (depth > 0 && d === "}") {
          depth -= 1;
          j += 1;
          continue;
        }
        if (depth === 0 && d === c) break;
        j += 1;
      }
      literals.push({ start: i, end: j + 1, value: text.slice(i + 1, j) });
      blank(i + 1, j);
      i = j + 1;
      previous = c;
      continue;
    }
    if (c === "/" && (previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous))) {
      // A regular expression literal: to its closing slash, escapes and classes included.
      let j = i + 1;
      let inClass = false;
      while (j < text.length) {
        const d = text[j] ?? "";
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        else if (d === "\n") break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      previous = "/";
      continue;
    }
    if (!/\s/.test(c)) previous = c;
    i += 1;
  }
  return { code: out.join(""), literals };
}

function read(path: string): Source {
  const text = readFileSync(join(DASHBOARD, path), "utf8");
  return { path, text, scan: scan(text) };
}

const tsIn = (directory: string): string[] =>
  readdirSync(join(DASHBOARD, directory))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(directory, name));

/** What runs in production: the server, src/, and the scripts a deployment runs. */
const PRODUCTION: Source[] = ["server.ts", ...tsIn("src"), ...tsIn("scripts")].map(read);

/** Every line of `code` matching `pattern`, as `path:line`, for a failure that says where. */
function where(source: Source, pattern: RegExp): string[] {
  const found: string[] = [];
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of source.scan.code.matchAll(global)) {
    const line = source.scan.code.slice(0, match.index).split("\n").length;
    found.push(`${source.path}:${line}`);
  }
  return found;
}

const everywhere = (pattern: RegExp, sources: Source[] = PRODUCTION) =>
  sources.flatMap((source) => where(source, pattern));

describe("the tokenizer this file reads the sources with", () => {
  test("blanks comments and literal contents, and keeps the literals", () => {
    const { code, literals } = scan(
      'const a = "OWNER_SELF"; // OWNER_SELF\nconst r = /x\\/\\/y/g; /* current() */ const b = `SELECT ${x} FROM t`;',
    );
    expect(code).not.toContain("OWNER_SELF");
    expect(code).not.toContain("current()");
    expect(code).not.toContain("SELECT");
    expect(literals.map((one) => one.value)).toEqual(["OWNER_SELF", "SELECT ${x} FROM t"]);
  });
});

describe("no read that falls back on account 1", () => {
  test("OWNER_SELF exists nowhere in production", () => {
    expect(everywhere(/\bOWNER_SELF\b/)).toEqual([]);
  });

  test("current() is called nowhere", () => {
    expect(everywhere(/\bcurrent\s*\(\s*\)/)).toEqual([]);
  });

  test("no parameter defaults to a Sources", () => {
    // Annotated - `sources: Sources = ...` - or not, `(paths, sources = sourcesFor(x))`.
    expect(everywhere(/:\s*Sources\s*=(?![=>])/)).toEqual([]);
    expect(everywhere(/[(,]\s*sources\s*=(?![=>])/)).toEqual([]);
  });

  test("sourcesOf( is called by src/secrets.ts alone", () => {
    const outside = PRODUCTION.filter((source) => source.path !== join("src", "secrets.ts"));
    expect(everywhere(/\bsourcesOf\s*\(/, outside)).toEqual([]);
    // And it is still there: a rename would make the line above pass for nothing.
    expect(everywhere(/\bsourcesOf\s*\(/, PRODUCTION.filter((source) => source.path === join("src", "secrets.ts")))).not.toEqual([]);
  });

  test("the founder is FOUNDING_ACCOUNT, never a literal owner: 1", () => {
    expect(everywhere(/\bowner\s*:\s*1\b/)).toEqual([]);
  });
});

/** A statement on one of the tables that belong to an account. */
const SCOPED_TABLE = /\b(FROM|INTO|UPDATE|JOIN|TABLE)\s+(jobs|labels|profiles|machine_origins)\b/i;

/** The one statement allowed to name no account: the sweep of jobs a restart left running. */
const EXCEPTION = "interruptRunning";

type Statement = { owner: string; sql: string; line: number };

/** Every SQL statement src/db.ts hands SQLite, with the query key or function that holds it. */
function statementsOf(source: Source): Statement[] {
  const { code, literals } = source.scan;
  const found: Statement[] = [];
  for (const match of code.matchAll(/\bdb\s*\.\s*(query|prepare|run|exec)\b/g)) {
    let i = (match.index ?? 0) + match[0].length;
    // Past a generic argument list, `<{ id: number }, [string]>`, nesting included.
    while (/\s/.test(code[i] ?? "")) i += 1;
    if (code[i] === "<") {
      let depth = 0;
      for (; i < code.length; i += 1) {
        const c = code[i];
        if (c === "<") depth += 1;
        else if (c === ">" && code[i - 1] !== "=") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
      while (/\s/.test(code[i] ?? "")) i += 1;
    }
    if (code[i] !== "(") continue;
    const open = i;
    let depth = 0;
    for (; i < code.length; i += 1) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const close = i;
    const sql = literals
      .filter((one) => one.start > open && one.end <= close)
      .map((one) => one.value)
      .join("");
    const lineStart = code.lastIndexOf("\n", match.index ?? 0) + 1;
    const before = code.slice(lineStart, match.index);
    const key = /(\w+)\s*:\s*$/.exec(before)?.[1];
    const fn = [...code.slice(0, match.index).matchAll(/\bfunction\s+(\w+)/g)].pop()?.[1];
    found.push({
      owner: key ?? fn ?? "?",
      sql,
      line: code.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

describe("every statement on jobs, labels and profiles names its account", () => {
  const db = read(join("src", "db.ts"));
  const statements = statementsOf(db);
  const scoped = statements.filter((one) => SCOPED_TABLE.test(one.sql));

  test("the reading found them: a parser that found none would pass everything", () => {
    expect(statements.length).toBeGreaterThan(20);
    expect(scoped.length).toBeGreaterThanOrEqual(12);
    expect(scoped.map((one) => one.owner)).toContain(EXCEPTION);
  });

  test("each one says account_id, interruptRunning alone excepted", () => {
    const missing = scoped
      .filter((one) => one.owner !== EXCEPTION && !/\baccount_id\b/.test(one.sql))
      .map((one) => `src/db.ts:${one.line} ${one.owner}`);
    expect(missing).toEqual([]);
  });

  test("and interruptRunning is still the sweep, not a read that answers a route", () => {
    const sweep = scoped.find((one) => one.owner === EXCEPTION);
    expect(sweep?.sql).toMatch(/^UPDATE jobs SET state = 'interrupted'/);
  });

  test("each function that runs one takes the account first, with no default", () => {
    const touching = new Set(scoped.map((one) => one.owner).filter((owner) => owner !== EXCEPTION));
    const offenders: string[] = [];
    let checked = 0;
    for (const match of db.scan.code.matchAll(/export\s+function\s+(\w+)\s*\(/g)) {
      const name = match[1] ?? "";
      const start = (match.index ?? 0) + match[0].length;
      const end = db.scan.code.indexOf("\n}\n", start);
      const body = db.scan.code.slice(start, end === -1 ? undefined : end);
      const uses = [...body.matchAll(/\bqueries\.(\w+)/g)].map((one) => one[1] ?? "");
      if (!uses.some((key) => touching.has(key))) continue;
      checked += 1;
      if (!/^\s*account\s*:\s*number\s*[,)]/.test(body)) offenders.push(name);
    }
    expect(checked).toBeGreaterThanOrEqual(12);
    expect(offenders).toEqual([]);
  });

  test("no other production file holds a statement on them", () => {
    // schema.ts declares the tables and carries step 2, which is the one place a statement on
    // them predates the account it gives them.
    const others = PRODUCTION.filter(
      (source) => source.path !== join("src", "db.ts") && source.path !== join("src", "schema.ts"),
    );
    const found = others.flatMap((source) =>
      source.scan.literals
        .filter((one) => SCOPED_TABLE.test(one.value))
        .map((one) => `${source.path}:${source.scan.code.slice(0, one.start).split("\n").length}`),
    );
    expect(found).toEqual([]);
  });
});
