###############################################################################
# Least-privilege IAM policies, one per pipeline stage.
#
# Invariants the policies enforce:
#   - ingest-api can write raw/, never read.
#   - sanitizer can move raw/ → quarantine/ and delete raw/, but cannot touch anon/.
#   - anonymizer can read raw/ and read+write anon/. NO Delete anywhere — eviction
#     is the sanitizer's job, gated by RAW_PROCESSED. This invariant prevents the
#     anonymizer from bypassing the two-phase delete protocol.
#   - processor is read-only on anon/.
###############################################################################

data "aws_iam_policy_document" "ingest_api" {
  statement {
    sid       = "WriteRawOnly"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/raw/*"]
  }

  statement {
    sid       = "ListBucketScoped"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.data.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["raw/*"]
    }
  }
}

data "aws_iam_policy_document" "sanitizer" {
  statement {
    sid       = "ReadRawForClassification"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.data.arn}/raw/*"]
  }

  statement {
    sid       = "DeleteRawAfterEviction"
    effect    = "Allow"
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.data.arn}/raw/*"]
  }

  statement {
    sid       = "MoveToQuarantine"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.data.arn}/quarantine/*"]
  }

  statement {
    sid       = "ListBucketScoped"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.data.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["raw/*", "quarantine/*"]
    }
  }
}

data "aws_iam_policy_document" "anonymizer" {
  statement {
    sid       = "ReadRawForScrub"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.data.arn}/raw/*"]
  }

  statement {
    sid       = "WriteAnonOutput"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/anon/*"]
  }

  statement {
    sid       = "ListBucketScoped"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.data.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["raw/*", "anon/*"]
    }
  }
}

data "aws_iam_policy_document" "processor" {
  statement {
    sid       = "ReadAnonOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.data.arn}/anon/*"]
  }

  statement {
    sid       = "ListBucketScoped"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.data.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["anon/*"]
    }
  }
}

###############################################################################
# IAM users + access keys, one per stage.
#
# Long-lived access keys are Phase 1 of the privacy hardening — sufficient for
# bootstrap, scoped tightly via the policies above. Phase 2 swaps these for
# short-lived credentials minted by Vault / IRSA / Workload Identity.
###############################################################################

locals {
  stages = {
    ingest-api = data.aws_iam_policy_document.ingest_api.json
    sanitizer  = data.aws_iam_policy_document.sanitizer.json
    anonymizer = data.aws_iam_policy_document.anonymizer.json
    processor  = data.aws_iam_policy_document.processor.json
  }
}

resource "aws_iam_user" "stage" {
  for_each = local.stages

  name = "ingest-pipeline-${var.environment}-${each.key}"
  path = "/ingest-pipeline/"
  tags = local.common_tags
}

resource "aws_iam_user_policy" "stage" {
  for_each = local.stages

  name   = "${each.key}-policy"
  user   = aws_iam_user.stage[each.key].name
  policy = each.value
}

resource "aws_iam_access_key" "stage" {
  for_each = local.stages

  user = aws_iam_user.stage[each.key].name
}
