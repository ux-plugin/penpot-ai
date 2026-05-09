terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  # Remote state — uncomment + tailor when promoting beyond a single operator.
  # backend "s3" {
  #   bucket         = "<your-tfstate-bucket>"
  #   key            = "ingest-pipeline/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "<your-tfstate-lock-table>"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region
}
