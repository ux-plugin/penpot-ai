resource "scaleway_object_bucket" "data" {
  name = local.bucket_name
  tags = local.common_tags

  # Versioning OFF on purpose — every prefix has a TTL and we rely on real
  # deletes (sanitizer evicts raw/ once anonymizer is done). Versioning would
  # extend a raw chunk's lifetime past the eviction signal, defeating the
  # privacy guarantee.
  versioning {
    enabled = false
  }

  lifecycle_rule {
    id      = "raw-ttl"
    enabled = true
    prefix  = "raw/"
    expiration {
      days = var.raw_retention_days
    }
  }

  lifecycle_rule {
    id      = "quarantine-ttl"
    enabled = true
    prefix  = "quarantine/"
    expiration {
      days = var.quarantine_retention_days
    }
  }

  lifecycle_rule {
    id      = "anon-ttl"
    enabled = true
    prefix  = "anon/"
    expiration {
      days = var.anon_retention_days
    }
  }
}

# Lock the bucket private. Scaleway treats this as the equivalent of AWS's
# bucket public-access block.
resource "scaleway_object_bucket_acl" "data" {
  bucket = scaleway_object_bucket.data.name
  acl    = "private"
}
