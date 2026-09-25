import { render } from "ink";
import type { ReactNode } from "react";
import { has, parse, type Parsed } from "./args.ts";
import { corePassthrough, getNotices } from "./core.ts";
import { INTERACTIVE } from "./settings.ts";
import { Fleet } from "./ui/Fleet.tsx";
import { Gate } from "./ui/Gate.tsx";
import { Help } from "./ui/Help.tsx";
import { Info } from "./ui/Info.tsx";
import { Orphans } from "./ui/Orphans.tsx";
import { Probe } from "./ui/Probe.tsx";
import { Profiles } from "./ui/Profiles.tsx";
import { Task } from "./ui/Task.tsx";
import { openWindow } from "./ui/tui/window.tsx";

/**
 * The renderer. devbox-core remains the executor.
 *
 * `devbox` at the root is a shell script that decides between the two: a terminal gets this,
 * a pipe gets the core untouched. Everything here therefore assumes stdout is a terminal
 * and nothing here assumes stdin is one.
 *
 * A verb this file does not recognise is handed straight to the core, terminal and all.
 * That is not politeness — it is what keeps ONE tool: an unknown flag must produce the
 * core's own error, and a verb added to the core must work through `devbox` the day it lands,
 * without a second dispatch table having to hear about it.
 */

/** The screen a verb renders, or null when the core should be given the terminal. */
function screen(parsed: Parsed): ReactNode | null {
  switch (parsed.command) {
    case "ls":
      return <Fleet />;
    case "profiles":
      return <Profiles />;
    case "probe":
      return <Probe parsed={parsed} />;
    case "orphans":
      return <Orphans parsed={parsed} />;
    case "info":
      return <Info parsed={parsed} />;
    case "up":
    case "seed":
    case "down":
    case "sync":
    case "tunnel":
      return <Task parsed={parsed} />;
    case "help":
    case "-h":
    case "--help":
      // `--full` is the core's own leading comment block, which is where the reasoning
      // lives. Rendering it here would mean keeping a copy of it here.
      return has(parsed, "--full") ? null : <Help />;
    default:
      return null;
  }
}

/** One Ink app, awaited to its end, leaving the status it set. */
async function show(node: ReactNode, options: { alternateScreen?: boolean } = {}): Promise<void> {
  // Ctrl-C is refused by Ink and handled by the screens that take the keyboard. `up` in
  // particular must not vanish silently: a `terraform apply` interrupted halfway leaves a
  // server billing that no state records, and saying so is the whole point of catching it.
  // The screens that never call useInput never enter raw mode, so Ctrl-C reaches them as
  // an ordinary SIGINT and behaves exactly as it always did.
  const app = render(node, { exitOnCtrlC: false, ...options });
  await app.waitUntilExit();
  // Removes the instance for this stdout, and with it the alternate screen. Without it a
  // second render() on the same stream would inherit the first one's terminal state.
  app.cleanup();
}

/** The notices no screen is left to draw, in the shape every other layer draws them. */
function flushNotices(): void {
  for (const line of getNotices()) process.stderr.write(`\u001B[33m  /!\\ ${line}\u001B[0m\n`);
}

const first = parse(process.argv.slice(2));

/**
 * `devbox` alone opens the window; `devbox help` still prints the list.
 *
 * The window needs a keyboard, and the shim only promises a terminal on stdout — so with
 * a stdin that is not a terminal, a bare `devbox` falls back to the printed help, which is
 * what it always was.
 */
let chosen: Parsed = first;

if (first.command === "" && INTERACTIVE) {
  const wanted = await openWindow();
  if (wanted === null) {
    // Gate never mounts on this path, so whatever the core warned about while the window
    // was drawing a view would leave with the window. The version gate is the one that
    // matters: the fleet the reader just looked at was served by an engine that may not be
    // this file, and a warning nobody sees renders exactly like agreement. Written plainly
    // rather than re-rendered, because Ink has already given the terminal back.
    flushNotices();
    process.exit(0);
  }
  chosen = parse(wanted);
} else if (first.command === "") {
  chosen = parse(["help"]);
}

const node = screen(chosen);

if (node === null) {
  const argv = [chosen.command, ...chosen.rest].filter((token) => token !== "--full");
  process.exit(await corePassthrough(argv));
}

await show(<Gate>{node}</Gate>);
process.exit(process.exitCode ?? 0);
