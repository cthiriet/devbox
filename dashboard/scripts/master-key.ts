#!/usr/bin/env bun
/**
 * Prints a new master key for the secrets vault, to be set as DEVBOX_MASTER_KEY in the
 * service's environment.
 *
 *   bun scripts/master-key.ts          v1, the first key
 *   bun scripts/master-key.ts 2        v2, the key a rotation moves to
 *
 * Drawn here, printed once, and kept nowhere by this script, which writes nothing and talks
 * to nothing. The database does not keep it either, on purpose: a key stored beside what it
 * seals seals nothing. So the only copy that outlives a lost server is the one you put in a
 * password manager - and without it, every secret in the database is gone for good.
 */
import { newMasterKey } from "../src/vault";

const argument = process.argv[2];

// Checked on the text and not on Number(), which reads "", " 2" and "0x2" as numbers.
if (argument !== undefined && !/^[1-9][0-9]{0,8}$/.test(argument)) {
  process.stderr.write(`a version is a whole number from 1, and ${JSON.stringify(argument)} is not\n`);
  process.exit(1);
}
const version = argument === undefined ? 1 : Number(argument);

process.stderr.write(
  [
    "Put this key in a password manager before you set it anywhere.",
    "It is the only copy. The database seals every secret under it and never stores it, so a",
    "lost key makes every secret in the database unrecoverable: there is no reset.",
    "",
    "Set it as DEVBOX_MASTER_KEY in the service's environment, which the service reads only",
    "when it starts. For a rotation, the key it replaces moves to DEVBOX_MASTER_KEY_PREVIOUS",
    "until every data key has been rewrapped under the new one.",
    "",
  ].join("\n"),
);

// On stdout alone, so `bun scripts/master-key.ts | pbcopy` carries the key and none of the
// guidance, which went to stderr.
console.log(newMasterKey(version));
