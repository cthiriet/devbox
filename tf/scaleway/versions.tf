terraform {
  required_version = ">= 1.5"

  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = ">= 2.50, < 3.0"
    }
  }
}

# Credentials come from SCW_ACCESS_KEY, SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID in the
# environment, which the wrapper sources from ~/.config/devbox/.env.tf. Nothing secret
# belongs in this directory, and nothing here reads ~/.config/scw/config.yaml: that file
# points at the default project, where the bare metal host of the kubevirt branch lived;
# these machines are deliberately somewhere else.
provider "scaleway" {
  zone   = var.zone
  region = var.region
}
