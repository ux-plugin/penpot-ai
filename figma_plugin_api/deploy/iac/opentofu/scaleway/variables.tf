variable "region" {
  description = "Scaleway region for Object Storage (fr-par, nl-ams, pl-waw)."
  type        = string
  default     = "fr-par"
}

variable "zone" {
  description = "Scaleway zone — only matters for compute resources, but the provider requires it."
  type        = string
  default     = "fr-par-1"
}

variable "environment" {
  description = "Deploy environment label, e.g. dev/staging/prod."
  type        = string
}

variable "project_id" {
  description = "Scaleway project ID. IAM applications + policies are scoped to this project."
  type        = string
}

variable "bucket_name" {
  description = "Object Storage bucket name. Must be unique within the region. Default appends the environment to a stable prefix."
  type        = string
  default     = ""
}

variable "raw_retention_days" {
  description = "Lifecycle TTL for the raw/ prefix. Sanitizer normally evicts within seconds via the two-phase delete."
  type        = number
  default     = 1
}

variable "quarantine_retention_days" {
  description = "Lifecycle TTL for the quarantine/ prefix."
  type        = number
  default     = 7
}

variable "anon_retention_days" {
  description = "Lifecycle TTL for the anon/ prefix."
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
