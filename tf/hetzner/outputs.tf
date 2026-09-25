# The contract. Identical in the three roots, and the only thing the wrapper knows about
# a cloud: adding a fourth is writing a root that answers these seven.

output "ip" {
  value = hcloud_server.devbox.ipv4_address
}

output "user" {
  # Created by cloud-init, key only, passwordless sudo. root login is refused.
  value = "dev"
}

output "port" {
  value = 22
}

output "cloud" {
  value = "hetzner"
}

output "region" {
  # Location, not datacenter: hcloud_server.datacenter is deprecated ahead of Hetzner
  # removing the concept, and the probe reads availability per location for the same
  # reason.
  value = hcloud_server.devbox.location
}

output "instance_type" {
  value = hcloud_server.devbox.server_type
}

output "hourly_eur" {
  value       = var.hourly_eur
  description = "Server plus primary IPv4, as read from the API at order time."
}
