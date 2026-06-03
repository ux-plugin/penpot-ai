terraform {
  required_version = ">= 1.7.0"
  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.49"
    }
  }

  # Remote state — Scaleway Object Storage is S3-compatible, so the official
  # `s3` backend works against it once you set the right endpoint + region.
  # Uncomment + tailor when promoting beyond a single operator.
  # backend "s3" {
  #   bucket                      = "<your-tfstate-bucket>"
  #   key                         = "ingest-pipeline/terraform.tfstate"
  #   region                      = "fr-par"
  #   endpoints                   = { s3 = "https://s3.fr-par.scw.cloud" }
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_metadata_api_check     = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  # }
}

provider "scaleway" {
  # Credentials come from the standard env vars: SCW_ACCESS_KEY,
  # SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID, SCW_DEFAULT_ORGANIZATION_ID.
  # The provider also supports `~/.config/scw/config.yaml`. We deliberately
  # don't pin them in HCL so secrets stay out of the repo.
  region = var.region
  zone   = var.zone
}
