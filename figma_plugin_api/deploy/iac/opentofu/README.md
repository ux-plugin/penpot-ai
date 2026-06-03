# OpenTofu modules — ingest pipeline IaC

Two cloud targets, same output contract. Pick one per environment.

```
deploy/iac/opentofu/
├── aws/         # AWS S3 + IAM users + per-user policies
└── scaleway/    # Scaleway Object Storage + IAM applications + bucket policy
```

Both modules:

- Provision one S3-compatible bucket with private ACL, versioning disabled, AES256 server-side encryption (where the cloud's default supports it), and prefix-scoped lifecycle rules for `raw/`, `quarantine/`, `anon/`.
- Mint four per-stage identities (`ingest-api`, `sanitizer`, `anonymizer`, `processor`) with least-privilege scoping enforced by:
  - **AWS**: per-user inline policies — `aws_iam_user_policy`.
  - **Scaleway**: project-wide IAM permission set + a single `scaleway_object_bucket_policy` that scopes each application down to its prefixes.
- Surface the same `stage_credentials` output (`{stage → {access_key_id, secret_access_key}}`), so the kubectl secret-extraction snippet in `aws/README.md` works against either module unchanged.

## Same invariants in both modules

| Stage | Reads | Writes | Deletes |
|---|---|---|---|
| `ingest-api` | — | `raw/*` | — |
| `sanitizer` | `raw/*`, `quarantine/*` | `quarantine/*` | `raw/*`, `quarantine/*` |
| `anonymizer` | `raw/*`, `anon/*` | `anon/*` | — |
| `processor` | `anon/*` | — | — |

Critical: the anonymizer never has Delete in either module. Eviction stays the sanitizer's job, gated by the `RAW_PROCESSED` event from the anonymizer. This invariant prevents either stage from bypassing the two-phase delete protocol — losing it would defeat the privacy guarantee.

## Picking a cloud

| Question | AWS | Scaleway |
|---|---|---|
| EU data residency required (GDPR-leaning customers) | Possible (eu-west-3 etc.) | Native — Scaleway is a French/EU operator |
| Workload identity available (short-lived creds) | Yes — IRSA on EKS | No equivalent yet — long-lived API keys only |
| Hyperscaler ecosystem (managed Postgres, Redis, k8s) | Mature | Smaller but covers the basics (Managed DB for PostgreSQL, Managed Redis, Kapsule k8s) |
| Pricing for object storage | Standard tier ~$0.023/GB/mo | Standard tier ~€0.014/GB/mo (often cheaper) |
| Egress costs | Charged | First 75GB/mo free per project, then €0.01/GB |

For pure cost-conscious / EU-resident deployments → **Scaleway**. For breadth of services + IRSA → **AWS**.

## Apply flow (identical pattern, different working directory)

```bash
cd deploy/iac/opentofu/<aws|scaleway>
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars

tofu init
tofu plan
tofu apply

tofu output -json stage_credentials > /tmp/stage-creds.json
# Loop in aws/README.md feeds these into kubectl create secret.
```

## App-side differences

The Spring Boot apps don't know which cloud minted their credentials — they just consume the same env-var pairs. The only knobs that change between targets:

| Env var | AWS | Scaleway |
|---|---|---|
| `OBJECTSTORE_ENDPOINT` | unset (uses `https://s3.<region>.amazonaws.com`) | `https://s3.<region>.scw.cloud` |
| `OBJECTSTORE_REGION` | e.g. `us-east-1` | e.g. `fr-par` |
| `OBJECTSTORE_BUCKET` | output of `tofu output bucket_name` | same |

Wire those via `kubectl create configmap` or your CD pipeline.

## State backend

Both modules ship with their `backend "s3"` block commented out. For:

- **AWS**: standard `s3` backend with DynamoDB lock.
- **Scaleway**: Scaleway Object Storage is S3-compatible, so the same `s3` backend works once you set `endpoints.s3 = "https://s3.<region>.scw.cloud"` plus the `skip_credentials_validation` / `skip_region_validation` / `use_path_style` flags. See `scaleway/versions.tf`.

Enable the backend once a second operator joins.

## What is shared between the two modules

Nothing yet — each module is fully self-contained. Sharing variables or resources between them would defeat the point: if you outgrow one cloud, you cut the other module loose without disturbing the survivor.

When/if a third cloud joins (GCP, Azure), copy whichever module is closest to the target and adapt — provider, IAM primitives, bucket policy syntax. The `stage_credentials` output stays the same shape so downstream tooling never breaks.
