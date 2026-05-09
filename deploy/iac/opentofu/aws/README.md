# OpenTofu module — ingest pipeline AWS resources

Provisions:
- One S3 bucket (`zoetrope-data-<env>` by default) with public-access block, AES256 encryption, and prefix-scoped lifecycle rules for `raw/`, `quarantine/`, `anon/`.
- Four IAM users — one per pipeline stage — each with an inline least-privilege policy:

| Stage | Allowed | Forbidden |
|---|---|---|
| `ingest-api` | `s3:PutObject` on `raw/*`, scoped `ListBucket raw/*` | reading anything; touching `anon/`, `quarantine/` |
| `sanitizer` | GET+PUT+DELETE on `raw/*` and `quarantine/*` | `anon/*` entirely |
| `anonymizer` | GET on `raw/*`, GET+PUT on `anon/*` | **DeleteObject anywhere** (eviction is sanitizer's job, gated by RAW_PROCESSED) |
| `processor` | GET on `anon/*` | mutation of any kind |

- Four access keys, one per user. Output via `tofu output stage_credentials`.

## Tooling

[OpenTofu](https://opentofu.org) ≥ 1.7. Apache-2.0 fork of Terraform — same HCL, same provider registry, no BSL drama.

```bash
brew install opentofu          # macOS
# or download from https://github.com/opentofu/opentofu/releases
```

## Apply

```bash
cd deploy/iac/opentofu/aws
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars       # set environment, tags, retention overrides

tofu init
tofu plan
tofu apply
```

Review the plan before applying. Double-check the bucket name is unique and the IAM users do not collide with existing resources in your account.

## Pull the per-stage access keys into k8s Secrets

```bash
# Single map output — `jq` extracts each stage's pair.
tofu output -json stage_credentials > /tmp/stage-creds.json

for stage in ingest-api sanitizer anonymizer processor; do
  ak=$(jq -r ".\"$stage\".access_key_id"     /tmp/stage-creds.json)
  sk=$(jq -r ".\"$stage\".secret_access_key" /tmp/stage-creds.json)

  case $stage in
    ingest-api) name=api-s3-creds          ;;
    *)          name=${stage}-s3-creds     ;;
  esac

  case $stage in
    ingest-api) ak_var=OBJECTSTORE_ACCESS_KEY  ; sk_var=OBJECTSTORE_SECRET_KEY ;;
    sanitizer)  ak_var=SANITIZER_S3_ACCESS_KEY ; sk_var=SANITIZER_S3_SECRET_KEY ;;
    anonymizer) ak_var=ANONYMIZER_S3_ACCESS_KEY; sk_var=ANONYMIZER_S3_SECRET_KEY ;;
    processor)  ak_var=PROCESSOR_S3_ACCESS_KEY ; sk_var=PROCESSOR_S3_SECRET_KEY ;;
  esac

  kubectl create secret generic "$name" \
    --from-literal=$ak_var="$ak" \
    --from-literal=$sk_var="$sk" \
    --dry-run=client -o yaml | kubectl apply -f -
done

rm /tmp/stage-creds.json
```

For real deploys, replace this script with your secret-sync controller (External Secrets Operator + AWS Secrets Manager, Sealed Secrets, etc.) — never paste raw keys into shell history.

## State

Default backend is local. Enable the commented-out `backend "s3"` block in `versions.tf` once a second operator joins, supplying an S3 bucket + DynamoDB lock table you've created out-of-band.

## What this module does NOT cover (yet)

- KMS customer-managed keys (drop-in via `aws_kms_key` + `sse_algorithm = "aws:kms"` swap in `bucket.tf`)
- Cross-account replication for backup/DR
- IRSA / Workload Identity — Phase 2 of #47, when long-lived access keys become a problem
- Any non-AWS provider — for GCP / Azure, fork the module and swap the resource types; the policy invariants port directly
