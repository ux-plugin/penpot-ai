resource "aws_s3_bucket" "data" {
  bucket = local.bucket_name
  tags   = local.common_tags
}

# Block all public access — this bucket carries raw user-session replay data.
resource "aws_s3_bucket_public_access_block" "data" {
  bucket = aws_s3_bucket.data.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Server-side encryption with bucket-key (cheaper than per-object KMS calls).
# Swap to a customer-managed KMS key when compliance requires it.
resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id

  # Versioning OFF on purpose — every prefix has a TTL and we rely on real
  # deletes (sanitizer evicts raw/ once anonymizer is done). Versioning would
  # extend the raw chunk's lifetime past the eviction signal, defeating the
  # privacy guarantee. Re-enable only after redesigning eviction.
  versioning_configuration {
    status = "Disabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket = aws_s3_bucket.data.id

  rule {
    id     = "raw-ttl"
    status = "Enabled"
    filter { prefix = "raw/" }
    expiration { days = var.raw_retention_days }
  }

  rule {
    id     = "quarantine-ttl"
    status = "Enabled"
    filter { prefix = "quarantine/" }
    expiration { days = var.quarantine_retention_days }
  }

  rule {
    id     = "anon-ttl"
    status = "Enabled"
    filter { prefix = "anon/" }
    expiration { days = var.anon_retention_days }
  }
}
