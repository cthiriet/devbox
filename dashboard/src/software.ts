/**
 * What a composed profile can install, and what each one demands in exchange.
 *
 * One declaration, read twice: the page draws the form from it, and the server validates a
 * saved profile against it. The rule that matters is the second half - "this software wants
 * that secret" exists HERE and nowhere else. Written once in the form and once in a
 * validator, the two would agree until the day one of them learned about a new entry.
 *
 * `install` names functions of prelude.sh and nothing else. That is the whole safety
 * property of the renderer: a form can only ever produce calls that this file already
 * spells, so nothing a reader types becomes shell. The recipes themselves live in the
 * prelude since 12/09, moved out of profiles/claude.sh and profiles/opencode.sh word for
 * word - see the section header there.
 *
 * The order of this array IS the order of installation, and it is the profiles' own: what
 * downloads comes first and the repository last, so a seed dying on a CDN dies before it
 * has cloned anything. `needs` is a plain inclusion, deduplicated in catalogue order - a
 * topological sort for seven entries would be machinery standing in for a list somebody can
 * read.
 */

/**
 * What a profile secret is, told to someone who has never met the name: what it is called,
 * what it does for the machine, where to get one, and what a good one starts with.
 *
 * Keyed by the secret's NAME and not by the software, because the name is what every screen
 * holds: /secrets lists names, /new greys a card on a name, a 412 names what is missing, and
 * `github` is asked for by the GitHub CLI and by every private repository alike. One entry
 * per name, here, so the four cannot describe the same token four ways.
 *
 * A name this file does not know - a profile written by hand may call its secret anything -
 * has no guide, and the pages show it as the name it is, with a field that takes anything.
 *
 * `prefixes` and `mistakes` are for a WARNING drawn under the field, never a refusal, on the
 * page or here: the server stores whatever it is given, because a hand-written profile may
 * well name something else `claude`, and a token format can change on the issuer's side the
 * day after this list was written. The one mistake worth naming is the one measured in the
 * profiles themselves: an Anthropic API key where Claude Code wants its OAuth token
 * (profiles/claude.sh says the two are not interchangeable, and install_claude_code exports
 * the file as CLAUDE_CODE_OAUTH_TOKEN).
 *
 * `steps` mark a command or a value to type between backticks; the page sets those in mono.
 * Written in the issuer's own words for its menus, since that is what the reader will see.
 */
export type SecretGuide = {
  name: string;
  label: string;
  /** One sentence: what the machine gains. */
  purpose: string;
  steps: readonly string[];
  /** The issuer's page where one is made, opened in a new tab. */
  link: { href: string; text: string } | null;
  /** What a value of this kind starts with, as the issuer hands it out. */
  prefixes: readonly string[];
  /** A value that is recognisably something ELSE, and what to say about it. */
  mistakes: readonly { prefix: string; says: string }[];
};

export const SECRET_GUIDES: readonly SecretGuide[] = [
  {
    name: "github",
    label: "GitHub token",
    purpose: "Lets your machine clone your private repositories and open pull requests.",
    // The two permissions and the repository access are devbox-core's own preflight, in
    // cmd_seed: a fine-grained token left on "Public repositories" cannot see a private one,
    // and a token with Contents alone pushes a branch and then answers 403 to `gh pr create`.
    steps: [
      "Open GitHub's page for a new fine-grained token, and give it a name.",
      "Repository access: choose Only select repositories, then the repositories your machines work on.",
      "Permissions: set Contents and Pull requests to Read and write.",
      "Generate the token, copy it, and paste it here.",
    ],
    link: { href: "https://github.com/settings/personal-access-tokens/new", text: "Open GitHub" },
    prefixes: ["github_pat_", "ghp_"],
    mistakes: [],
  },
  {
    name: "claude",
    label: "Claude Code token",
    purpose: "Signs Claude Code in on your machines with your Claude subscription.",
    steps: [
      "On your own computer, with Claude Code installed and signed in, open a terminal.",
      "Run `claude setup-token` and follow what it asks.",
      "Paste the token it prints here.",
    ],
    link: null,
    prefixes: ["sk-ant-oat01-"],
    mistakes: [
      {
        prefix: "sk-ant-api",
        says: "This is an Anthropic API key. Machines sign Claude Code in with the token `claude setup-token` prints, and an API key does not work in its place.",
      },
    ],
  },
  {
    name: "openrouter",
    label: "OpenRouter API key",
    purpose: "Lets opencode on your machines use models through your OpenRouter account.",
    steps: ["Open OpenRouter's API keys page and create a key.", "Copy the key and paste it here."],
    link: { href: "https://openrouter.ai/keys", text: "Open OpenRouter" },
    prefixes: ["sk-or-"],
    mistakes: [],
  },
];

const GUIDE_BY_NAME = new Map(SECRET_GUIDES.map((guide) => [guide.name, guide]));

export function secretGuide(name: string): SecretGuide | undefined {
  return GUIDE_BY_NAME.get(name);
}

/** A secret an entry cannot work without, named as the profile will declare it. */
export type SoftwareSecret = {
  /** The name under DEVBOX_SECRETS_DIR and /run/secrets: what `devbox-secrets:` carries. */
  name: string;
  /**
   * False for a secret the machine is useful without. `github` is the only one today: the
   * GitHub CLI installs and works read-only without a token, and claude.sh has always
   * degraded rather than died on it.
   *
   * OPTIONAL IS NOT DECLARED BY DEFAULT, since 13/09. devbox-core knows no optional secret: a
   * declared name is one describeProfiles counts as missing, prepareLaunch refuses with a
   * 412, and cmd_seed asks for at the keyboard. So a composed profile declares an optional
   * secret only when its form turned it on (ProfileSpec.optional), and from then on it is
   * required like any other. The page said "optional" for a name that blocked every order.
   */
  required: boolean;
  label: string;
  /** What this entry does with it, or without it. Shown under the field. */
  help: string;
};

export type Software = {
  id: string;
  label: string;
  /** One line, what the machine gains. */
  note: string;
  secrets: readonly SoftwareSecret[];
  /** Other ids, pulled in whether or not the form ticked them. */
  needs: readonly string[];
  /** The `step` banner the seed log shows above the calls. */
  step: string;
  /** Calls into prelude.sh, in order. */
  install: readonly string[];
  /**
   * Installed AFTER the repositories rather than before them.
   *
   * True for the two agents, and it is not a preference: Claude Code's onboarding gate is
   * written for `$REPO_DIR`, the directory the clone leaves behind, and a gate written for a
   * directory that does not exist yet is a gate that does nothing. profiles/claude.sh has
   * had this order since it was written; the renderer keeps it rather than rediscovering it.
   */
  afterRepos: boolean;
};

export const SOFTWARE: readonly Software[] = [
  {
    id: "node",
    label: "Node (LTS)",
    note: "node, npm and npx from nodejs.org, current LTS, into /usr/local.",
    secrets: [],
    needs: [],
    step: "node",
    install: ["install_node"],
    afterRepos: false,
  },
  {
    id: "python",
    label: "Python (uv)",
    note: "uv and an interpreter of its own under /opt, never the system python3.",
    secrets: [],
    needs: [],
    step: "python",
    install: ["install_python"],
    afterRepos: false,
  },
  {
    id: "bun",
    label: "Bun",
    note: "bun and bunx under /opt, symlinked into the PATH.",
    secrets: [],
    needs: [],
    step: "bun",
    install: ["install_bun"],
    afterRepos: false,
  },
  {
    // 132 MB, and it pulls Node in for chrome-devtools-mcp, which is an npm package: the
    // dependency is the prelude's, not this file's invention.
    id: "chrome",
    label: "Chrome + chrome-devtools-mcp",
    note: "A headless browser an agent can drive, and the MCP server that drives it.",
    secrets: [],
    needs: ["node"],
    step: "chrome + chrome-devtools-mcp",
    install: ["install_chrome"],
    afterRepos: false,
  },
  {
    id: "gh",
    label: "GitHub CLI",
    note: "gh, authenticated from the github secret, so an agent can open a pull request.",
    secrets: [
      {
        name: "github",
        required: false,
        label: "GitHub token",
        help: "Lets gh push and open pull requests. Without it gh still installs, and commits keep the dev@devbox.local identity.",
      },
    ],
    needs: [],
    step: "gh",
    install: ["install_gh"],
    afterRepos: false,
  },
  {
    id: "claude",
    label: "Claude Code",
    note: "Claude Code installed and authenticated, with the browser registered as an MCP server.",
    secrets: [
      {
        name: "claude",
        required: true,
        label: "Claude Code token",
        help: "Claude Code cannot sign in without it. It is the token `claude setup-token` prints, not an Anthropic API key.",
      },
    ],
    needs: ["node", "chrome"],
    step: "claude code",
    install: ["install_claude_code"],
    afterRepos: true,
  },
  {
    id: "opencode",
    label: "opencode",
    note: "opencode installed, OpenRouter enabled from the environment, browser registered.",
    secrets: [
      {
        name: "openrouter",
        required: true,
        label: "OpenRouter API key",
        help: "opencode reaches no model without it. It is read from the environment, so it never lands in opencode's auth.json.",
      },
    ],
    needs: ["node", "chrome"],
    step: "opencode",
    install: ["install_opencode"],
    afterRepos: true,
  },
];

const BY_ID = new Map(SOFTWARE.map((one) => [one.id, one]));

export function software(id: string): Software | undefined {
  return BY_ID.get(id);
}

/**
 * The chosen entries plus what they need, in catalogue order and without repetition.
 *
 * Catalogue order rather than the order they were ticked: the form is a set of checkboxes
 * and a reader ticking Claude Code before Node must not get a profile that installs the
 * browser's MCP package before npm exists.
 */
export function resolved(ids: readonly string[]): Software[] {
  const wanted = new Set<string>();
  const add = (id: string) => {
    if (wanted.has(id)) return;
    wanted.add(id);
    for (const need of BY_ID.get(id)?.needs ?? []) add(need);
  };
  for (const id of ids) if (BY_ID.has(id)) add(id);
  return SOFTWARE.filter((one) => wanted.has(one.id));
}

/**
 * The secrets the chosen software asks for, required or not.
 *
 * Which of the optional ones reach `devbox-secrets:` is the spec's decision, not this list's:
 * see declaredSecrets in src/profiles.ts, and SoftwareSecret.required above for why an
 * optional name declared by default was a name that blocked the order.
 */
export function secretsOf(ids: readonly string[]): SoftwareSecret[] {
  const seen = new Map<string, SoftwareSecret>();
  for (const one of resolved(ids)) {
    for (const secret of one.secrets) {
      const already = seen.get(secret.name);
      // Required wins over optional: two entries asking for the same name, one of which
      // cannot work without it, is a name the profile cannot work without.
      if (already === undefined || (!already.required && secret.required)) seen.set(secret.name, secret);
    }
  }
  return [...seen.values()];
}
