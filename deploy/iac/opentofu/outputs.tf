output "bucket_name" {
  description = "S3 bucket carrying every pipeline prefix (raw/, quarantine/, anon/)."
  value       = aws_s3_bucket.data.id
}

output "bucket_region" {
  description = "Region the bucket lives in. Pass to `objectstore.region` in app config."
  value       = aws_s3_bucket.data.region
}

# Per-stage credentials. Marked sensitive so they don't render in plain `tofu
# apply` / CI logs. Pull them with:
#   tofu output -raw stage_credentials > /tmp/creds.json
# and feed the values into your k8s Secret manifests via `kubectl create secret`
# or your secret-sync controller.
output "stage_credentials" {
  description = "Map of {stage → {access_key_id, secret_access_key}} for each pipeline stage."
  value = {
    for k, key in aws_iam_access_key.stage :
    k => {
      access_key_id     = key.id
      secret_access_key = key.secret
    }
  }
  sensitive = true
}
