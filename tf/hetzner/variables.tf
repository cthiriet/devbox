variable "name" {
  type        = string
  default     = "devbox"
  description = "Server name, hostname, and prefix for the key and firewall it owns."
}

variable "server_type" {
  type        = string
  description = <<-EOT
    Hetzner SKU, chosen by the wrapper's probe rather than defaulted here. There is no
    default on purpose: the cheapest x86 offer meeting the template moves week to week,
    and a constant in this file would be a constant that is wrong. `devbox probe` prints
    what is creatable right now.
  EOT
}

variable "location" {
  type        = string
  description = <<-EOT
    Where the machine lands, chosen by the probe from what is creatable at that instant.

    No default, for a reason worth spelling out: a production module pins
    location = "fsn1" and forgets it, and Falkenstein has been unable to create ANY x86 machine of
    8 vCPU or more on every day this was checked, while Nuremberg and Helsinki offered
    eight types. A machine that copied that constant would fail on a perfectly healthy
    account, and the failure would look like a broken token.
  EOT
}

variable "server_image" {
  type        = string
  default     = "ubuntu-24.04"
  description = "Base image. 24.04 is what the kubevirt branch built its dev image on, and what phase 1 assumes."
}

variable "ssh_public_key" {
  type        = string
  description = "Public half of the operator key, injected at create time and registered in the project."
}

variable "hourly_eur" {
  type        = string
  description = <<-EOT
    Hourly price, server plus primary IPv4, as the wrapper read it from the API when it
    picked this offer.

    It is passed in rather than derived here because it has to mean the same thing in the
    three roots, and it cannot be derived in all three: GCP publishes no price API usable
    without enabling the billing catalog, so its figure is a dated static table in the
    wrapper. Keeping the arithmetic in one place is what makes `hourly_eur` comparable
    across clouds instead of being three different notions with one name.
  EOT
}

variable "ssh_source_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
  description = <<-EOT
    Who may reach port 22. Open by default: a mobile address changes at every
    reconnection, and a rule that pins it closes on you from a train. What is exposed is
    an sshd with PasswordAuthentication no and a single key-only account, whose key has
    no passphrase. Narrow it if you only ever connect from one network.
  EOT
}
