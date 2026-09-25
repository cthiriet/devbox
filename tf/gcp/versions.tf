terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
  }
}

# No credentials here, and two of them can arrive from outside.
#
# On a workstation, Application Default Credentials, refreshed with `gcloud auth
# application-default login`. Where there is no browser to refresh them in — the dashboard
# is a systemd unit — a service account key, named by GOOGLE_APPLICATION_CREDENTIALS, which
# devbox-core exports once that key has actually minted a token. Either way the provider
# reads the environment and this file names nothing.
#
# The second was refused here, in so many words, until 31/08, and the argument ran: a JSON
# key is a long-lived secret on a disk, and on GCP it buys no isolation anyway, the
# credential being the USER's and already reaching every project they can see. The first
# half is still true. The second half was about the wrong credential. A service account
# minted for this holds two roles on one scratch project, which is NARROWER than the
# operator's own login, not wider — so the choice is not "isolation or none", it is "the
# operator's whole account, refreshed by hand, or a key that can create and destroy
# instances in one project". Hetzner and Scaleway each got a project of their own to
# contain a leaked credential; a service account is how that same containment is spelled
# here, and the shared project below is what it is scoped to.
#
# What stays true of the key is its lifetime: nothing expires it. It lives where every
# other secret of this fleet lives, in 0400 under $DEVBOX_SECRETS_DIR, and it rotates the
# way the rest do: a new file there, no restart.
provider "google" {
  project = var.project
  region  = var.region
  zone    = var.zone
}
