variable "project" {
  type        = string
  description = <<-EOT
    Where the machine lands, passed by devbox-core from DEVBOX_GCP_PROJECT.

    No default, deliberately, and for a stronger reason than location's: a project IS an
    account. A wrong location costs latency, a wrong project creates an instance and a
    firewall rule in someone else's, and bills them for it. Use one of its own, with
    Compute enabled and set as the ADC quota project — never the one running a service you
    care about.
  EOT
}

variable "name" {
  type        = string
  default     = "devbox"
  description = "Instance name, and prefix for the firewall rule it owns."
}

variable "machine_type" {
  type        = string
  description = "Chosen by the probe. No default, for the same reason as the other two roots."
}

variable "zone" {
  type        = string
  description = <<-EOT
    Zone, not region, and the probe iterates over the zones of a region rather than
    picking one. GCP publishes no availability signal at all: the only way to learn that a
    zone is out of a machine type is to order and read ZONE_RESOURCE_POOL_EXHAUSTED.
  EOT
}

variable "region" {
  type        = string
  description = "Region the zone belongs to. Carries the CPUS quota, which is regional."
}

variable "server_image" {
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
  description = "Ubuntu 24.04, x86. The arm64 image would install everything up to the Chrome package."
}

variable "boot_disk_gb" {
  type        = number
  default     = 80
  description = "Boot disk. Billed separately from the instance, and it is what survives a stop — hence `down` destroys."
}

variable "boot_disk_type" {
  type        = string
  default     = "pd-balanced"
  description = "pd-balanced rather than pd-ssd: the four image builds are not IOPS-bound, they are CPU and network bound."
}

variable "network" {
  type        = string
  default     = "default"
  description = <<-EOT
    The project's default VPC. The firewall rule below is scoped by network tag, so it
    applies to this instance alone and to nothing else already living in that network.
  EOT
}

variable "ssh_public_key" {
  type        = string
  description = "Public half of the operator key, delivered through instance metadata."
}

variable "hourly_eur" {
  type        = string
  description = "Instance plus boot disk, as the wrapper computed it when it picked this shape."
}

variable "ssh_source_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = "Who may reach port 22. Same trade-off as the other two roots: a mobile address cannot be pinned."
}
