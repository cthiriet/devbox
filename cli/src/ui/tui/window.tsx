import { render, type Instance } from "ink";
import type { ReactNode } from "react";
import { coreJson, coreJsonDetailed, coreQuiet } from "../../core.ts";
import { listening } from "../../local.ts";
import type { Machine, Offer, Orphan, Profile } from "../../types.ts";
import { AskSecret } from "../AskSecret.tsx";
import { Loading } from "../common.tsx";
import { held, store } from "../../secrets.ts";
import { remote } from "../../settings.ts";
import { Machines } from "./Machines.tsx";
import { Menu } from "./Menu.tsx";
import { OrphansView, ProfileStep, ShapeStep } from "./Pickers.tsx";

/**
 * The window, and the rule that shapes it: **it never loads while it is listening.**
 *
 * This is not a preference. Measured on this Bun with ink 7.1.1: while an Ink app that
 * takes the keyboard is mounted, the event loop stops. Timers stop firing, child processes
 * are not reaped, and a promise waiting on one of them settles at the moment the next
 * keystroke arrives — not before. A one-second `devbox ls` behind a spinner reported itself
 * finished six seconds later, exactly when a key was pressed, having drawn two frames in
 * between. An Ink app that takes NO input has none of this: the same command behind the
 * same spinner drew seventy-five frames and finished on time.
 *
 * So the two are never mounted together. A load runs under a spinner with no keyboard; the
 * screen that follows is handed finished data and does no I/O of its own. Every key that
 * needs something fetched or run comes back here as an intent, is carried out between
 * mounts, and the window is drawn again.
 *
 * The cost is a redraw per action. The alternative is a window that freezes for as long as
 * whatever it is doing takes, which for `devbox probe` is half a minute of a frozen spinner —
 * indistinguishable, to the person in front of it, from a crash.
 */

/**
 * Where the window is, and what that place needs in order to be drawn.
 *
 * A place rather than a name, because `up` is two screens and the second one cannot be
 * fetched without the first one's answer: the shapes shown are the shapes above THIS
 * profile's floors. Carrying the profile in the position itself is what keeps the loop
 * below stateless — nothing is remembered between two mounts except where we are.
 */
export type Step =
  | { view: "menu" }
  | { view: "machines" }
  | { view: "profile" }
  | { view: "shape"; profile: Profile }
  | { view: "orphans" };

export type View = Step["view"];

/** What a screen asks for, once it has a keystroke it cannot answer on its own. */
export type Intent =
  | { do: "go"; to: Step }
  | { do: "quit" }
  | { do: "reload" }
  | { do: "launch"; argv: string[] }
  | { do: "core"; argv: string[] };

/** What each screen is drawn from. Fetched here, never inside a screen. */
type Data =
  | { view: "menu" }
  | { view: "machines"; machines: Machine[]; open: Record<string, boolean> }
  | { view: "profile"; profiles: Profile[] }
  | { view: "shape"; profile: Profile; offers: Offer[]; skipped: string }
  | { view: "orphans"; orphans: Orphan[] }
  | { view: "failed"; where: Step; why: string };

/**
 * Opens the window and stays in it until it is closed.
 *
 * Resolves with the command to run in the ordinary terminal — `up`, `seed`, `down`, `info`
 * — or null when the window was simply closed. Those verbs deliberately do NOT run in
 * here: the alternate screen has no scrollback, and a five-minute `up` whose terraform
 * output vanished when the window closed would be a tool nobody could debug.
 */
export async function openWindow(): Promise<string[] | null> {
  // The dashboard token, before anything is asked of the dashboard. Every verb goes
  // through it when DEVBOX_REMOTE is set — `ls` as much as `up` — and devbox-core cannot prompt
  // for it from under a window that owns the keyboard.
  if (remote() !== "" && !held("remote")) {
    const token = await ask((resolve) => (
      <AskSecret
        name="remote"
        onAnswer={(value) => resolve({ do: "core", argv: [value] })}
        onCancel={() => resolve({ do: "quit" })}
      />
    ));
    if (token.do !== "core" || !token.argv[0]) return null;
    store("remote", token.argv[0]);
  }

  let step: Step = { view: "menu" };

  for (;;) {
    const data = await withSpinner(step.view, () => fetchFor(step));
    const intent = await ask((resolve) => draw(data, resolve));

    if (intent.do === "quit") return null;
    if (intent.do === "launch") return intent.argv;
    if (intent.do === "go") {
      step = intent.to;
      continue;
    }
    if (intent.do === "core") {
      // Short verbs only — `tunnel`, and the closing of one. Run with no window mounted,
      // which is the only place anything can be run at full speed, and then the screen is
      // drawn again from what the world now looks like.
      await withSpinner(step.view, () => coreQuiet(intent.argv));
    }
    // "reload" falls through to the top, which is the reload.
  }
}

/** The wait, with a spinner and no keyboard. */
async function withSpinner<T>(view: View, run: () => Promise<T>): Promise<T> {
  // The menu is drawn from nothing at all, so it gets no spinner: a frame that appears and
  // vanishes inside the same millisecond is a flash, not feedback.
  const label = WAITING[view];
  if (!label) return run();

  const app = render(<Loading label={label} />);
  try {
    return await run();
  } finally {
    app.unmount();
    await app.waitUntilExit();
    app.clear();
    app.cleanup();
  }
}

const WAITING: Record<View, string> = {
  menu: "",
  machines: "reading the fleet, and its forwards",
  profile: "reading the profile directories",
  shape: "asking the clouds what they can create right now",
  orphans: "asking the providers what they are running",
};

/** One interactive screen, mounted until it has an intent. */
function ask(node: (resolve: (intent: Intent) => void) => ReactNode): Promise<Intent> {
  return new Promise((resolve) => {
    let app: Instance | null = null;
    let done = false;
    const finish = (intent: Intent) => {
      if (done) return;
      done = true;
      app?.unmount();
      app?.cleanup();
      resolve(intent);
    };
    // The alternate screen, so the window is a window: it goes away when it closes, and
    // the terminal it was opened from comes back untouched.
    app = render(node(finish), { exitOnCtrlC: false, alternateScreen: true });
  });
}

/**
 * The floors of a profile, as `probe` takes them.
 *
 * Only the ones the header actually sets. A floor left out here falls back to the core's
 * own default, and that is the point: `cmd_up` fills the same blanks with the same 4/8/80,
 * so the list this screen shows is the list `up` is about to choose from — not a
 * neighbouring one computed here.
 */
function floors(profile: Profile): string[] {
  const flags: string[] = [];
  if (profile.min_cpu !== null) flags.push("--min-cpu", String(profile.min_cpu));
  if (profile.min_ram !== null) flags.push("--min-ram", String(profile.min_ram));
  if (profile.min_disk !== null) flags.push("--min-disk", String(profile.min_disk));
  return flags;
}

async function fetchFor(step: Step): Promise<Data> {
  try {
    if (step.view === "machines") {
      const machines = await coreJson<Machine[]>(["ls"], 60_000);
      const ports = await Promise.all(machines.map((m) => listening(m.local_port)));
      return {
        view: "machines",
        machines,
        open: Object.fromEntries(machines.map((m, i) => [m.name, ports[i] ?? false])),
      };
    }
    if (step.view === "profile") {
      return { view: "profile", profiles: await coreJson<Profile[]>(["profiles"], 30_000) };
    }
    if (step.view === "shape") {
      const answer = await coreJsonDetailed<Offer[]>(["probe", ...floors(step.profile)], 180_000);
      return { view: "shape", profile: step.profile, offers: answer.data, skipped: answer.stderr };
    }
    if (step.view === "orphans") {
      return { view: "orphans", orphans: await coreJson<Orphan[]>(["orphans"], 180_000) };
    }
    return { view: "menu" };
  } catch (cause) {
    return {
      view: "failed",
      where: step,
      why: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function draw(data: Data, done: (intent: Intent) => void): ReactNode {
  switch (data.view) {
    case "machines":
      return <Machines machines={data.machines} open={data.open} done={done} />;
    case "profile":
      return <ProfileStep profiles={data.profiles} done={done} />;
    case "shape":
      return (
        <ShapeStep
          profile={data.profile}
          offers={data.offers}
          stderr={data.skipped}
          done={done}
        />
      );
    case "orphans":
      return <OrphansView orphans={data.orphans} done={done} />;
    case "failed":
      return <Menu failure={data.why} done={done} />;
    default:
      return <Menu done={done} />;
  }
}
