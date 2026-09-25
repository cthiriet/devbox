# The contract, identical in every root.

output "ip" {
  value = google_compute_instance.devbox.network_interface[0].access_config[0].nat_ip
}

output "user" {
  value = "dev"
}

output "port" {
  value = 22
}

output "cloud" {
  value = "gcp"
}

output "region" {
  # The zone: GCP's resource pools are per zone, and that is the granularity a retry moves
  # across when an order comes back exhausted.
  value = google_compute_instance.devbox.zone
}

output "instance_type" {
  value = google_compute_instance.devbox.machine_type
}

output "hourly_eur" {
  value = var.hourly_eur
}
