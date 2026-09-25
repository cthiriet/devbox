/**
 * The clouds as a person names them, and what it takes to connect one.
 *
 * `gcp` is the name of the DATA - a Terraform root, a variable prefix, an argument - and it
 * stays that everywhere the data goes. On a screen it was `gcp` in lowercase mono, which reads
 * as a typo of a company nobody has heard of. The three words live on the server too
 * (src/vault.ts#CLOUD_NAMES), for the sentences a refusal hands back; this copy is for the
 * screens that no answer describes - a badge on a machine, a button on an offer.
 *
 * The guides are this page's copy and nothing else: which fields a cloud has, and whether each
 * is set, still come from `GET /api/secrets`. What is written here is only what the reader
 * will meet in the provider's own console, and each claim is one the repository can stand
 * behind:
 *
 *   hetzner   one token, per project, Read & Write: tf/hetzner creates and destroys.
 *   scaleway  three values (src/vault.ts#CLOUD_FIELDS, measured 11/09 against the provider),
 *             and their shapes read out of scaleway provider 2.81.0 itself: `^SCW[A-Z0-9]{17}$`
 *             for the access key, a lowercase UUID for the secret key and for the project.
 *   gcp       tf/gcp creates an instance and a firewall rule in one project, with Compute. The
 *             key already names its project, so the page takes `project_id` from it and does
 *             not ask; it is still SENT, as DEVBOX_GCP_PROJECT, and still changeable, because
 *             devbox-core never reads the project out of a key (gcp_token: a key can act on
 *             projects it was not minted in). Which roles the service account needs has never
 *             been measured - docs/deploy.md says so - and none is named here.
 */

export const CLOUD_NAMES: Record<string, string> = {
  hetzner: "Hetzner",
  scaleway: "Scaleway",
  gcp: "Google Cloud",
  aws: "AWS",
  azure: "Azure",
  oracle: "Oracle Cloud",
  digitalocean: "DigitalOcean",
  ovh: "OVHcloud",
  vultr: "Vultr",
}

/**
 * The providers a tile announces and nothing orders on yet.
 *
 * Written here and NOT in the server's CLOUDS, which is the whole safety of saying it at all:
 * a name in this list reaches one tile on the settings page and no further - not `clouds()`,
 * not the order form, not a Terraform root - so nothing can accept a machine on a provider
 * that has no root behind it. The day one is written, its id joins the server's list and it
 * leaves this one, in the same commit.
 *
 * Six, and two full rows of the grid: the three hyperscalers this tool does not reach yet,
 * then the three that sell an hour of a machine for what this tool exists to spend. A row
 * left with one tile on it reads as an accident, so the list grows by three - and it is a
 * statement of intent rather than a catalogue: the tile says `Soon` and promises no month.
 *
 * Alibaba Cloud and Tencent are majors this list leaves out, and that is a choice about who
 * opens this page rather than a judgement: a machine is ordered in the region its owner sits
 * in, and nothing here is written for that half of the world yet.
 */
export const SOON: readonly string[] = [
  "aws",
  "azure",
  "oracle",
  "digitalocean",
  "ovh",
  "vultr",
]

/** A cloud's name, or its id for one this file has not heard of. */
export function cloudName(cloud: string): string {
  return CLOUD_NAMES[cloud] ?? cloud
}

/**
 * The clouds whose disk is ASKED FOR at the order, rather than sold with the type.
 *
 * On Hetzner a cx33 comes with 80 GB, and the probe's `disk_gb` is the disk. On the other
 * two, devbox-core sizes the root itself from `--min-disk` - `root_volume_gb` in tf/scaleway,
 * `boot_disk_gb` in tf/gcp, both set to MIN_DISK_GB in scw_up and gcp_up - and the probe's
 * figure is something else: the most the type can hold on Scaleway (`volumes_constraint`,
 * whatever root the order then asks for), the floor it was asked at on GCP. So the disk a
 * machine will have is `disk_gb` on Hetzner, and the floor the order carries on the other two.
 */
export const DISK_ASKED: ReadonlySet<string> = new Set(["scaleway", "gcp"])

export type GuideStep = { text: string; link?: { href: string; text: string } }

export type FieldCopy = {
  label: string
  /** Where the value is found, under the label. */
  hint?: string
  /** Not a secret - a project's ID - and drawn in clear, so a filled-in value can be checked. */
  reveal?: boolean
}

export type Provider = {
  cloud: string
  name: string
  /**
   * One quiet word under the provider's tile on /secrets, while no cloud is connected: all
   * that is left, before a tap, of saying which one to start with. The panel says the rest.
   */
  tag: string | null
  intro: string
  steps: GuideStep[]
  fields: Record<string, FieldCopy>
  /** What was given, for the refusal's first sentence: "this token", "these keys". */
  given: string
  /** What to look at after a refusal, before the provider's own words. */
  retry: string
  /**
   * Warnings about what was typed, by field name, from its shape alone. NEVER a refusal: a
   * provider may change a format the day after this was written, and the test that follows
   * is the provider's own answer.
   */
  check: (typed: Record<string, string>) => Record<string, string>
  /**
   * A field the page fills from another and does not ask for: `field` is hidden until `from`
   * is typed, then shown as one line with a way to change it - or as the field itself when
   * `from` suggests nothing.
   */
  derived?: { field: string; from: string; says: string }
  /** A value one field suggests for another: the GCP key names its project. */
  suggest?: (
    name: string,
    value: string
  ) => { field: string; value: string } | null
}

const SCW_ACCESS = /^SCW[A-Z0-9]{17}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Google's rule for a project ID: 6 to 30 characters, a letter first, no dash last. */
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/

const PROVIDERS: Record<string, Provider> = {
  hetzner: {
    cloud: "hetzner",
    name: "Hetzner",
    tag: "Easiest",
    intro:
      "One token. Machines are created in your Hetzner account and billed there, by the hour.",
    steps: [
      {
        text: "Open the Hetzner Cloud console and create a project just for your machines.",
        link: {
          href: "https://console.hetzner.cloud/",
          text: "Open Hetzner console",
        },
      },
      { text: "In that project, go to Security, then API tokens." },
      { text: "Choose Generate API token, with the permission Read & Write." },
      { text: "Copy the token and paste it below." },
    ],
    fields: { HCLOUD_TOKEN: { label: "API token" } },
    given: "this token",
    retry:
      "Check that the whole token was copied, and that it has Read & Write permission.",
    check: () => ({}),
  },
  scaleway: {
    cloud: "scaleway",
    name: "Scaleway",
    tag: null,
    intro:
      "An API key, which is two values, and the project your machines are created in.",
    steps: [
      {
        text: "In the Scaleway console, open IAM, then API keys, and generate an API key.",
        link: {
          href: "https://console.scaleway.com/iam/api-keys",
          text: "Open Scaleway console",
        },
      },
      {
        text: "Copy the access key and the secret key right away: the secret key is shown only once.",
      },
      {
        text: "Open the settings of the project your machines go in, and copy its Project ID.",
        link: {
          href: "https://console.scaleway.com/project/settings",
          text: "Open Project settings",
        },
      },
      { text: "Paste the three values below." },
    ],
    fields: {
      SCW_ACCESS_KEY: { label: "Access key (starts with SCW)" },
      SCW_SECRET_KEY: {
        label: "Secret key",
        hint: "Shown once, when the API key is generated.",
      },
      SCW_DEFAULT_PROJECT_ID: {
        label: "Project ID",
        hint: "In Project settings.",
        reveal: true,
      },
    },
    given: "these keys",
    retry:
      "Check that each value is in its own field, and that the project belongs to the same account as the key.",
    check: (typed) => {
      const access = typed.SCW_ACCESS_KEY ?? ""
      const secret = typed.SCW_SECRET_KEY ?? ""
      const project = typed.SCW_DEFAULT_PROJECT_ID ?? ""
      const said: Record<string, string> = {}
      // A paste into the wrong field is the mistake these shapes are for, so it is named as
      // one rather than as two unrelated malformed values.
      if (access !== "" && !SCW_ACCESS.test(access)) {
        said.SCW_ACCESS_KEY =
          UUID.test(access) && SCW_ACCESS.test(secret)
            ? "These two look swapped: the access key is the one that starts with SCW."
            : "An access key starts with SCW and is 20 characters long."
      }
      if (
        secret !== "" &&
        !UUID.test(secret) &&
        said.SCW_ACCESS_KEY === undefined
      ) {
        said.SCW_SECRET_KEY = SCW_ACCESS.test(secret)
          ? "This looks like the access key: the secret key is the long value with dashes."
          : "A secret key is 36 characters: lowercase letters and digits in groups, with dashes."
      }
      if (project !== "") {
        if (project === secret)
          said.SCW_DEFAULT_PROJECT_ID =
            "This is the secret key again: the Project ID is in Project settings."
        else if (!UUID.test(project))
          said.SCW_DEFAULT_PROJECT_ID =
            "A Project ID is 36 characters: lowercase letters and digits in groups, with dashes."
      }
      return said
    },
  },
  gcp: {
    cloud: "gcp",
    name: "Google Cloud",
    tag: null,
    intro: "A service account key file. The project comes from the key.",
    steps: [
      {
        text: "Use a Google Cloud project of its own for your machines, not one that runs anything else.",
        link: {
          href: "https://console.cloud.google.com/projectcreate",
          text: "Create a project",
        },
      },
      {
        text: "Enable the Compute Engine API in that project.",
        link: {
          href: "https://console.cloud.google.com/apis/library/compute.googleapis.com",
          text: "Open Compute Engine API",
        },
      },
      {
        text: "Create a service account there, allowed to create and delete Compute Engine instances and firewall rules in that project. Add a JSON key to it, and download the file.",
        link: {
          href: "https://console.cloud.google.com/iam-admin/serviceaccounts",
          text: "Open Service accounts",
        },
      },
      {
        text: "Load the key file below.",
      },
    ],
    fields: {
      gcp: { label: "Key file (JSON)" },
      DEVBOX_GCP_PROJECT: {
        label: "Project ID",
        hint: "The project your machines are created in.",
        reveal: true,
      },
    },
    derived: { field: "DEVBOX_GCP_PROJECT", from: "gcp", says: "Project" },
    given: "this key and project",
    retry:
      "Which roles the service account needs has not been measured here: Google's own words below usually name what was missing.",
    check: (typed) => {
      const project = typed.DEVBOX_GCP_PROJECT ?? ""
      const said: Record<string, string> = {}
      if (project !== "" && !GCP_PROJECT.test(project)) {
        said.DEVBOX_GCP_PROJECT =
          "A Project ID is 6 to 30 lowercase letters, digits and dashes, starting with a letter."
      }
      return said
    },
    suggest: (name, value) => {
      if (name !== "gcp") return null
      const project = keyProject(value)
      return project === null
        ? null
        : { field: "DEVBOX_GCP_PROJECT", value: project }
    },
  },
}

/** A cloud this page has no guide for still gets a card: its name, and the fields as served. */
export function providerOf(cloud: string): Provider {
  return (
    PROVIDERS[cloud] ?? {
      cloud,
      name: cloudName(cloud),
      tag: null,
      intro: "",
      steps: [],
      fields: {},
      given: "these credentials",
      retry: "",
      check: () => ({}),
    }
  )
}

/**
 * The `project_id` a service account key names, or null. The key's other fields are the
 * private key and are never looked at; this one is an identifier the console prints in clear.
 */
export function keyProject(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null
    const project = (parsed as Record<string, unknown>).project_id
    return typeof project === "string" && project !== "" ? project : null
  } catch {
    return null
  }
}
