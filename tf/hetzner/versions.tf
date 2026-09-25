terraform {
  required_version = ">= 1.5"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = ">= 1.45, < 2.0"
    }
  }
}

# Deliberately empty: the token comes from HCLOUD_TOKEN in the environment, so it is
# never in a .tf file, never in terraform.tfvars, and never in the state. The wrapper
# sources it from ~/.config/devbox/.env.tf, which nothing else reads.
#
# That file should hold a token minted in a Hetzner project of its own. Tokens, SSH keys
# and firewalls are all project-scoped, so a dedicated project is what keeps a leaked
# devbox token away from the one serving your production.
provider "hcloud" {}
