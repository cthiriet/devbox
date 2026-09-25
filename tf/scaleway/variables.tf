variable "name" {
  type        = string
  default     = "devbox"
  description = "Server name, and prefix for the key, the IP and the security group it owns."
}

variable "instance_type" {
  type        = string
  description = <<-EOT
    Scaleway commercial type, chosen by the wrapper's probe. No default, for the same
    reason as the Hetzner root: the cheapest offer meeting the template moves, and a
    constant here would be a constant that is wrong.
  EOT
}

variable "zone" {
  type        = string
  description = "Availability zone, chosen by the probe from what is actually creatable there."
}

variable "region" {
  type        = string
  description = "Region the zone belongs to. fr-par-1 is in fr-par."
}

variable "server_image" {
  type        = string
  default     = "ubuntu_noble"
  description = "Marketplace label for Ubuntu 24.04, the release phase 1 and the kubevirt branch both assume."
}

variable "root_volume_gb" {
  type        = number
  default     = 80
  description = <<-EOT
    Root volume size. Unlike Hetzner, where the disk comes with the shape, Scaleway wants
    it asked for explicitly — within the ceiling the commercial type allows, which the
    probe reads from `volumes_constraint.max_size` and which is exactly 80 GB on DEV1-L.

    80 GB is the template's floor: the dev image's root is 30 GB, and the four images plus
    node_modules plus Postgres live next to it. Measured on Hetzner once the stack was
    served: 14 GB in use.
  EOT
}

variable "root_volume_type" {
  type        = string
  default     = "l_ssd"
  description = <<-EOT
    Storage backend for the root volume, and the probe only ever selects commercial types
    that take `l_ssd` — local SSD, included in the published hourly price.

    That is a deliberate narrowing. Scaleway splits its catalogue in two: types with a
    local disk (DEV1, whose `volumes_constraint` carries a non-zero max), and types that
    take none at all (PLAY2, BASIC3, which report `l_ssd` from 0 to 0 and require a
    separately billed block volume). No Scaleway API publishes a price for block storage
    or for a public IP — `products/volumes` returns constraints only, and
    `products/ips` 404s — so ordering a block-backed type would mean putting an invented
    constant into `hourly_eur`, in the one field whose whole job is to be comparable
    across clouds. Local-SSD types keep the figure entirely API-derived.

    Nothing worthwhile is lost today: on 19/08 the block-backed types were the more
    expensive ones anyway (PLAY2-MICRO at 0.055, BASIC3-X4C-8G at 0.079, against DEV1-L
    at 0.043). It also removes the orphaned-volume trap — a detached block volume goes on
    being billed alone, and there is now nothing to detach.
  EOT
}

variable "ssh_public_key" {
  type        = string
  description = "Public half of the operator key, registered in the project and injected at create time."
}

variable "hourly_eur" {
  type        = string
  description = <<-EOT
    Hourly price as the wrapper read it from the API: server, plus the root volume, plus
    the public IP. On Scaleway those are three line items rather than one, which is
    exactly why the figure is computed in the wrapper and passed in — so that hourly_eur
    means the same thing here as it does in the Hetzner root.
  EOT
}

variable "ssh_source_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = <<-EOT
    Who may reach port 22. Open by default, same trade-off the README argues for the
    sandbox host: a mobile address changes at every reconnection and a rule that pins it
    closes on you. What is exposed is an sshd with PasswordAuthentication no and a single
    key-only account.
  EOT
}
