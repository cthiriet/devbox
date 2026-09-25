/**
 * Keeps this process's memory and initial environment out of reach of every other process of
 * the same account - devbox-core, terraform, and every provider plugin terraform starts.
 *
 * WHY. openVault reads the master key and deletes it from process.env, and engineEnv withholds
 * its name: a child is never HANDED it. But a delete only unlinks the variable from the list
 * libc keeps; the bytes stay where the kernel put them at exec, in the block
 * /proc/<pid>/environ reads out, and that file is readable by any process of the same uid.
 * Measured on 11/09: after the delete, a child spawned exactly
 * as engineEnv spawns one read `DEVBOX_MASTER_KEY=...` back from /proc/$PPID/environ - and
 * with the key, it opens devbox.db, which the same account can read. /proc/<pid>/mem is the
 * same door to everything the vault ever decrypted.
 *
 * prctl(PR_SET_DUMPABLE, 0) closes both. proc(5): a process whose dumpable attribute is not 1
 * has its /proc/<pid> files owned by root, and the ptrace access check behind environ and mem
 * refuses a caller without CAP_SYS_PTRACE; a same-uid ptrace attach is refused too, and no
 * core dump is written - a core would be the whole heap, keyring included. The children
 * themselves are unaffected: exec resets the attribute, so they stay dumpable, and debuggable,
 * as they always were.
 *
 * What the process keeps. Access to its own /proc/self is decided by thread group, not by
 * owner, for everything Bun and JavaScriptCore read there (maps for the stack bounds, fd, exe,
 * statm); tests/secrets-api.test.ts runs the whole server under this on the Linux runner.
 *
 * Linux only, and nothing elsewhere. macOS has no prctl, and its `ps -E` (KERN_PROCARGS2)
 * still shows a same-uid process's initial environment: the development server on a Mac stays
 * exposed to its own children, which is a development machine's risk and not a server's.
 */
import { dlopen, FFIType } from "bun:ffi";

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

/**
 * Where libc is, by the names it goes by: glibc's soname first, which is every distribution
 * this runs on today, then musl's, for an Alpine image.
 */
const LIBC = ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"];

/** `null` off Linux, where there is nothing to do; otherwise whether it took, and why not. */
export type Undumpable = { applied: true } | { applied: false; reason: string };

/**
 * Called once, at startup, before the vault opens and before anything is spawned.
 *
 * Never throws. A failure is returned for server.ts to say out loud, and the service carries
 * on: dying here would loop on Restart=always, and a server that says "a child of this
 * account can read the master key back" is one the operator can do something about.
 *
 * prctl is variadic in its C declaration, and called here with a fixed five arguments. On the
 * two ABIs this runs on - x86-64 System V and AArch64 Linux - variadic integer arguments
 * travel in the same registers as fixed ones, which is what makes the fixed signature exact.
 * Read back with PR_GET_DUMPABLE rather than trusted from the return code alone.
 */
export function makeUndumpable(platform: string = process.platform): Undumpable | null {
  if (platform !== "linux") return null;

  const failures: string[] = [];
  for (const name of LIBC) {
    let library;
    try {
      library = dlopen(name, {
        prctl: {
          args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
          returns: FFIType.i32,
        },
      });
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      const set = library.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
      const now = library.symbols.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
      if (set === 0 && now === 0) return { applied: true };
      return {
        applied: false,
        reason: `prctl(PR_SET_DUMPABLE, 0) answered ${set}, and the process reads dumpable=${now}`,
      };
    } catch (error) {
      return {
        applied: false,
        reason: `prctl could not be called: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      library.close();
    }
  }
  return { applied: false, reason: `libc could not be opened (${failures.join("; ")})` };
}
