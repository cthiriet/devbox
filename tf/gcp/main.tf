# One instance, billed by the second with a one-minute minimum, destroyed by `devbox down`.
#
# Two GCP-specific traps are handled here and neither is optional.
#
# OS Login. If it is enabled at project or instance level, metadata SSH keys are ignored
# ENTIRELY and silently: the instance boots, sshd answers, and every key is refused with no
# hint as to why. Turning it off explicitly on the instance is what makes the metadata key
# below mean anything.
#
# The MTU. GCP's VPC is 1460 by default, so a Docker bridge left at 1500 reproduces the
# per-destination black hole diagnosed under KubeVirt. That one is handled in phase 1 —
# devbox-docker-mtu reads the interface's MTU at boot rather than pinning a number — so there
# is nothing to set here, which is precisely why the service was written that way.

resource "google_compute_firewall" "devbox" {
  name    = "${var.name}-ssh"
  network = var.network

  # Scoped to the tag, not to the network: this rule must not widen anything else that
  # happens to live in the default VPC.
  target_tags   = ["devbox"]
  source_ranges = var.ssh_source_cidrs

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # ICMP, including types 3 and 11, which carry path MTU discovery.
  allow {
    protocol = "icmp"
  }
}

resource "google_compute_instance" "devbox" {
  name         = var.name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["devbox"]

  boot_disk {
    auto_delete = true

    initialize_params {
      image = var.server_image
      size  = var.boot_disk_gb
      type  = var.boot_disk_type
    }
  }

  network_interface {
    network = var.network

    # An empty access_config is what asks for an ephemeral external address. Ephemeral on
    # purpose: a reserved static IP goes on being billed once nothing is attached to it,
    # and this machine's address is expected to change at every up anyway — the wrapper
    # rewrites ~/.ssh/config and known_hosts for exactly that reason.
    access_config {}
  }

  metadata = {
    # "dev:" prefixes the key with the login it authorises. Without the prefix GCP derives
    # a username from the key comment, and the account cloud-init created is not the one
    # you end up trying to log into.
    ssh-keys = "dev:${trimspace(var.ssh_public_key)}"

    # See the header. This single line is the difference between a working machine and one
    # that refuses every key without explanation.
    enable-oslogin = "FALSE"

    # cloud-init on GCP's Ubuntu images reads this key and no other.
    user-data = templatefile("${path.module}/../../cloud-init.yaml.tftpl", {
      ssh_public_key = trimspace(var.ssh_public_key)
      # Gzipped to agree with the template's `gz+b64`, whose comment says why.
      prelude_b64   = base64gzip(file("${path.module}/../../prelude.sh"))
      provision_b64 = base64gzip(file("${path.module}/../../devbox-provision.sh"))
    })
  }
}
