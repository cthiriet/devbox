# The contract, identical in every root. The wrapper knows nothing else about a cloud.

output "ip" {
  value = scaleway_instance_ip.devbox.address
}

output "user" {
  # Created by cloud-init, key only, passwordless sudo. root login is refused.
  value = "dev"
}

output "port" {
  value = 22
}

output "cloud" {
  value = "scaleway"
}

output "region" {
  # The zone, not the region: availability and price are published per zone, and fr-par-1
  # and fr-par-2 do not offer the same catalogue.
  value = scaleway_instance_server.devbox.zone
}

output "instance_type" {
  value = scaleway_instance_server.devbox.type
}

output "hourly_eur" {
  value       = var.hourly_eur
  description = "Server, root volume and public IP together, as read from the API at order time."
}
