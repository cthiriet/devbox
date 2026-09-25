# One cloud VM, billed by the hour, destroyed by `devbox down`.
#
# Nothing here carries prevent_destroy, unlike the production module next door, and the
# difference is the point: that machine holds the only copy of something, this one holds a
# clone of a git repository and is meant to be thrown away. Hetzner
# bills a powered-off server at FULL price, so destruction is the only thing that stops
# the meter.

# There is deliberately NO hcloud_ssh_key here.
#
# It was redundant from the start: the operator's key reaches the machine through
# cloud-init's `users: ssh_authorized_keys`, which is what authorises `dev`, the only
# account that exists. hcloud_ssh_key injects the same key into root's authorized_keys,
# and root login is refused.
#
# Redundant AND blocking, which is why it is gone rather than merely unused: Hetzner
# rejects two keys with the same fingerprint in one project, so registering it per
# instance is exactly what made a second concurrent machine impossible.
#
# The visible consequence is an email from Hetzner with a root password, because a server
# created with no ssh_keys gets one. It is inert here: the Ubuntu cloud image ships
# PasswordAuthentication no, and phase 1 restates it along with PermitRootLogin no before
# anything else can happen.

resource "hcloud_firewall" "devbox" {
  name = "${var.name}-fw"

  # ICMP from anywhere: ping is how you tell "the machine is down" from "the stack is
  # down", and types 3 and 11 carry path MTU discovery, which phase 1's MTU service
  # depends on to fail loudly rather than hang.
  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_source_cidrs
  }

  # There is deliberately NO rule for 9010 or 6443. The app and the cluster API are
  # reached through an SSH forward — Termius does local port forwarding on the phone —
  # so neither is ever published, and neither needs a firewall exception.

  # No outbound rule at all, which in Hetzner's model means egress is unrestricted. That
  # is required: the machine pulls from apt, npm, Docker Hub, half a dozen CDNs and a
  # model provider.
}

resource "hcloud_server" "devbox" {
  name        = var.name
  server_type = var.server_type
  location    = var.location
  image       = var.server_image

  firewall_ids = [hcloud_firewall.devbox.id]

  labels = {
    managed-by = "devbox"
  }

  # Phase 1. No secret is in here, and that is deliberate: the user-data is readable by
  # any process on the machine through 169.254.169.254, and cloud-init keeps a copy of it
  # under /var/lib/cloud. The tokens arrive later, over SSH, into tmpfs.
  user_data = templatefile("${path.module}/../../cloud-init.yaml.tftpl", {
    ssh_public_key = trimspace(var.ssh_public_key)
    # The shared prelude only. The profile travels at seed time, over SSH, with the
    # secrets it declares — so the user-data carries no choice and no secret.
    #
    # Gzipped, because Hetzner refuses a user_data over 32768 bytes, and the template's
    # `gz+b64` has to agree: its comment has the measure.
    prelude_b64   = base64gzip(file("${path.module}/../../prelude.sh"))
    provision_b64 = base64gzip(file("${path.module}/../../devbox-provision.sh"))
  })

  # No ignore_changes on user_data, unlike the prod module. cloud-init runs once, so
  # editing the template can only take effect by replacing the machine — and on a box
  # that is meant to be thrown away, being told "this will be replaced" is the honest
  # answer. The wrapper refuses `up` on a name that already exists, so no apply can reach
  # here by accident.
}
