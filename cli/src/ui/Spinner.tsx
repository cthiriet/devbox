import { Text } from "ink";
import { useEffect, useState } from "react";

/**
 * The braille spinner, hand-rolled.
 *
 * `ink-spinner` and `cli-spinners` would be two more dependencies for ten frames and a
 * `setInterval`, in a repository whose executor has no dependencies at all beyond curl,
 * jq and terraform. The frames are the standard `dots` set.
 *
 * 80ms is the usual cadence; Ink caps rendering at 30fps anyway, so a faster interval
 * would only produce frames nobody sees.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ color = "cyan" }: { color?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => (n + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);

  return <Text color={color}>{FRAMES[frame]}</Text>;
}

/**
 * How long the thing in front of you has been running.
 *
 * Shown from five seconds rather than from zero: every command here starts by spawning a
 * shell, and a timer that flashes `0s` on its way past is noise. Past five seconds the
 * wait is real — `probe` reads three cloud APIs, `up` waits six minutes on cloud-init —
 * and the number is the difference between "slow" and "hung".
 */
export function Elapsed({ since, from = 5 }: { since: number; from?: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.floor((now - since) / 1000);
  if (seconds < from) return null;

  const shown = seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
  return <Text dimColor> {shown}</Text>;
}
