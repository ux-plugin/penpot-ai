output "bucket_name" {
  description = "Object Storage bucket carrying every pipeline prefix (raw/, quarantine/, anon/)."
  value       = scaleway_object_bucket.data.name
}

output "bucket_region" {
  description = "Region the bucket lives in. Pass to `objectstore.region` in app config."
  value       = scaleway_object_bucket.data.region
}

output "bucket_endpoint" {
  description = "S3-compatible endpoint URL. Pass to `objectstore.endpoint` in app config."
  value       = "https://s3.${scaleway_object_bucket.data.region}.scw.cloud"
}

# Per-stage credentials. Same shape as the AWS module's `stage_credentials`
# output so the kubectl secret-extraction script in the AWS README works
# unchanged against this module's output.
output "stage_credentials" {
  description = "Map of {stage → {access_key_id, secret_access_key}} for each pipeline stage."
  value = {
    for k, key in scaleway_iam_api_key.stage :
    k => {
      access_key_id     = key.access_key
      secret_access_key = key.secret_key
    }
  }
  sensitive = true
}
