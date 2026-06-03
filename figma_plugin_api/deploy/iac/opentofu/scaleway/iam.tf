###############################################################################
# Per-stage IAM applications + API keys.
#
# Scaleway IAM "applications" are non-human identities. Each application gets
# an scaleway_iam_policy granting the project-wide ObjectStorage permission set
# it needs (read or full-access). Prefix-level granularity comes from a bucket
# policy below — Scaleway's IAM permission sets are coarser than AWS's
# resource-level policies, so we layer a bucket policy on top to enforce the
# same per-stage invariants.
###############################################################################

locals {
  # Per-stage shape: which Scaleway permission set the application needs at
  # project scope, and the S3 actions/resources its bucket-policy statement
  # will allow.
  stages = {
    ingest-api = {
      permission_set = "ObjectStorageObjectsWrite"
      actions        = ["s3:PutObject"]
      resources      = ["arn:aws:s3:::${scaleway_object_bucket.data.name}/raw/*"]
      list_prefixes  = ["raw/*"]
    }
    sanitizer = {
      permission_set = "ObjectStorageFullAccess"
      actions = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
      ]
      resources = [
        "arn:aws:s3:::${scaleway_object_bucket.data.name}/raw/*",
        "arn:aws:s3:::${scaleway_object_bucket.data.name}/quarantine/*",
      ]
      list_prefixes = ["raw/*", "quarantine/*"]
    }
    anonymizer = {
      # No DeleteObject anywhere — eviction is sanitizer's job, gated by
      # RAW_PROCESSED. ObjectStorageObjectsWrite covers GET+PUT at project
      # scope; bucket policy below scopes it down further.
      permission_set = "ObjectStorageObjectsWrite"
      actions = [
        "s3:GetObject",
        "s3:PutObject",
      ]
      resources = [
        "arn:aws:s3:::${scaleway_object_bucket.data.name}/raw/*",
        "arn:aws:s3:::${scaleway_object_bucket.data.name}/anon/*",
      ]
      list_prefixes = ["raw/*", "anon/*"]
    }
    processor = {
      permission_set = "ObjectStorageObjectsRead"
      actions        = ["s3:GetObject"]
      resources      = ["arn:aws:s3:::${scaleway_object_bucket.data.name}/anon/*"]
      list_prefixes  = ["anon/*"]
    }
  }
}

resource "scaleway_iam_application" "stage" {
  for_each = local.stages

  name        = "ingest-pipeline-${var.environment}-${each.key}"
  description = "Pipeline stage: ${each.key} (${var.environment})"
  tags        = [for k, v in local.common_tags : "${k}=${v}"]
}

resource "scaleway_iam_policy" "stage" {
  for_each = local.stages

  name           = "ingest-pipeline-${var.environment}-${each.key}-policy"
  application_id = scaleway_iam_application.stage[each.key].id
  description    = "Project-scoped permission set for the ${each.key} stage."

  rule {
    project_ids          = [var.project_id]
    permission_set_names = [each.value.permission_set]
  }
}

resource "scaleway_iam_api_key" "stage" {
  for_each = local.stages

  application_id = scaleway_iam_application.stage[each.key].id
  description    = "API key for ${each.key} (${var.environment})"
}

###############################################################################
# Bucket policy — scopes the project-wide IAM permissions down to specific
# prefixes per stage. Same invariants the AWS module enforces via per-user
# inline policies, expressed instead as a single bucket-side document.
###############################################################################

data "scaleway_account_project" "self" {
  project_id = var.project_id
}

locals {
  # Build the Statement list dynamically so adding a fifth stage means editing
  # only the `local.stages` map above.
  bucket_policy_statements = concat(
    [
      for stage_name, stage in local.stages : {
        Sid       = "${replace(stage_name, "-", "")}AllowedActions"
        Effect    = "Allow"
        Principal = {
          SCW = "application_id:${scaleway_iam_application.stage[stage_name].id}"
        }
        Action   = stage.actions
        Resource = stage.resources
      }
    ],
    [
      for stage_name, stage in local.stages : {
        Sid       = "${replace(stage_name, "-", "")}ListBucketScoped"
        Effect    = "Allow"
        Principal = {
          SCW = "application_id:${scaleway_iam_application.stage[stage_name].id}"
        }
        Action   = ["s3:ListBucket"]
        Resource = ["arn:aws:s3:::${scaleway_object_bucket.data.name}"]
        Condition = {
          StringLike = {
            "s3:prefix" = stage.list_prefixes
          }
        }
      }
    ],
  )
}

resource "scaleway_object_bucket_policy" "data" {
  bucket = scaleway_object_bucket.data.name
  policy = jsonencode({
    Version   = "2023-04-17"
    Id        = "ingest-pipeline-${var.environment}"
    Statement = local.bucket_policy_statements
  })
}
