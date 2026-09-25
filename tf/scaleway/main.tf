# One cloud instance, billed by the hour, destroyed by `devbox down`.
#
# The Hetzner root next door is the reference; this one answers the same output contract.
# Three differences are forced by the provider and none of them are preferences:
#
#   - the disk has to be sized explicitly, within a ceiling the commercial type sets;
#   - the public IP is its own resource, and an orphaned one bills on its own, which is
#     why it lives in this state and not outside it;
#   - inbound traffic is denied by a security group's default policy rather than allowed
#     by an absent rule.
#
# One figure is missing and worth naming: no Scaleway API publishes the price of a public
# IPv4 — products/ips 404s and the billing catalogue is not reachable with an instance
# key. hourly_eur therefore carries the server price alone, disk included since the probe
# only picks local-SSD types. See the note in variables.tf.

# There is deliberately NO scaleway_iam_ssh_key here, for the reason spelled out in the
# Hetzner root: the operator's key reaches the machine through cloud-init's
# `users: ssh_authorized_keys`, which is what authorises `dev` — the only account that
# exists. Registering it as an IAM object injects the same key for root, and root login is
# refused.
#
# It was also what made a second concurrent machine impossible: IAM rejects two keys with
# the same fingerprint, so one per instance cannot work.

resource "scaleway_instance_security_group" "devbox" {
  name = "${var.name}-sg"
  zone = var.zone

  # Scaleway's default is to accept inbound. Stated explicitly, because the whole posture
  # of this machine rests on exactly one open port.
  inbound_default_policy  = "drop"
  outbound_default_policy = "accept"

  dynamic "inbound_rule" {
    for_each = var.ssh_source_cidrs
    content {
      action   = "accept"
      port     = 22
      ip_range = inbound_rule.value
    }
  }

  # ICMP, so that "the machine is down" can be told from "the stack is down", and so that
  # types 3 and 11 get through — they carry path MTU discovery, which phase 1's MTU
  # service depends on to fail loudly instead of hanging.
  dynamic "inbound_rule" {
    for_each = var.ssh_source_cidrs
    content {
      action   = "accept"
      protocol = "ICMP"
      ip_range = inbound_rule.value
    }
  }

  # Nothing for 9010 or 6443: the app and the cluster API are reached through an SSH
  # forward and are never published.
}

# Its own resource, and deliberately inside this state. A flexible IP that outlives its
# instance keeps costing money by itself, and the only thing that reliably prevents an
# orphan is Terraform knowing it exists.
resource "scaleway_instance_ip" "devbox" {
  zone = var.zone
  type = "routed_ipv4"
}

resource "scaleway_instance_server" "devbox" {
  name  = var.name
  type  = var.instance_type
  image = var.server_image
  zone  = var.zone

  ip_id             = scaleway_instance_ip.devbox.id
  security_group_id = scaleway_instance_security_group.devbox.id
  tags              = ["devbox", "managed-by-devbox"]

  root_volume {
    size_in_gb  = var.root_volume_gb
    volume_type = var.root_volume_type
    # The single most expensive line in this file to get wrong. A volume that survives its
    # instance goes on being billed, and `down` exists precisely to stop the meter:
    # Scaleway's billing at rest — volume and IP even when the server is off — is half the
    # reason the wrapper offers no "stop" verb at all.
    delete_on_termination = true
  }

  # Phase 1. No secret in here: the user-data is readable from inside the instance through
  # the metadata service, and cloud-init keeps a copy of it under /var/lib/cloud. The
  # tokens arrive later, over SSH, into tmpfs.
  #
  # The map key must be exactly "cloud-init" — any other name and the file is delivered as
  # an ordinary metadata entry that nothing ever reads, which fails silently: the machine
  # boots, sshd answers, and none of the provisioning has happened.
  user_data = {
    cloud-init = templatefile("${path.module}/../../cloud-init.yaml.tftpl", {
      ssh_public_key = trimspace(var.ssh_public_key)
      # Gzipped to agree with the template's `gz+b64`, whose comment says why.
      prelude_b64   = base64gzip(file("${path.module}/../../prelude.sh"))
      provision_b64 = base64gzip(file("${path.module}/../../devbox-provision.sh"))
    })
  }
}
