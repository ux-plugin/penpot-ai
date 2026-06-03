variable "region" {
  description = "AWS region for the bucket and IAM resources."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deploy environment label, e.g. dev/staging/prod. Used in the bucket name and resource tags."
  type        = string
}

variable "bucket_name" {
  description = "S3 bucket name. Must be globally unique. Default appends the environment to a stable prefix."
  type        = string
  default     = ""
}

variable "raw_retention_days" {
  description = "Lifecycle TTL for the raw/ prefix. Sanitizer normally evicts within seconds via the two-phase delete; this is the safety net."
  type        = number
  default     = 1
}

variable "quarantine_retention_days" {
  description = "Lifecycle TTL for the quarantine/ prefix. Held for ops review."
  type        = number
  default     = 7
}

variable "anon_retention_days" {
  description = "Lifecycle TTL for the anon/ prefix. Anonymized data is the replay/training corpus."
  type        = number
  default     = 90
}

variable "tags" {
  description = "Common tags applied to every resource."
  type        = map(string)
  default     = {}
}

locals {
  bucket_name = coalesce(var.bucket_name, "zoetrope-data-${var.environment}")
  common_tags = merge({
    "app.kubernetes.io/part-of" = "ingest-pipeline"
    "environment"               = var.environment
  }, var.tags)
}
