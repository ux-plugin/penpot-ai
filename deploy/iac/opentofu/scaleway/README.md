# OpenTofu module — Scaleway target

Provisions the same ingest-pipeline infrastructure as the AWS module, on Scaleway:

- One Object Storage bucket (`zoetrope-data-<env>` by default) with private ACL, versioning disabled, and prefix-scoped lifecycle rules for `raw/`, `quarantine/`, `anon/`.
- Four `scaleway_iam_application` identities — one per pipeline stage — each with a project-scoped permission set:

| Stage | Permission set | Bucket-policy actions |
|---|---|---|
| `ingest-api` | `ObjectStorageObjectsWrite` | `s3:PutObject` on `raw/*` only |
| `sanitizer` | `ObjectStorageFullAccess` | GET+PUT+DELETE on `raw/*` and `quarantine/*` |
| `anonymizer` | `ObjectStorageObjectsWrite` | GET on `raw/*`, GET+PUT on `anon/*`. **No DeleteObject.** |
| `processor` | `ObjectStorageObjectsRead` | GET on `anon/*` only |

A single `scaleway_object_bucket_policy` layered on top of the bucket scopes those project-wide permissions down to specific prefixes, replicating the per-user inline policies from the AWS module.

- Four API keys (`scaleway_iam_api_key`), one per application. Surfaced via the same `stage_credentials` output the AWS module exposes, so the kubectl secret-extraction script ports without changes.

## Why a bucket policy and IAM both?

Scaleway's IAM permission sets are coarser than AWS's resource-level policies — `ObjectStorageObjectsWrite` grants `PutObject` on every bucket in the project, not just one. The bucket policy on top is what enforces the per-stage prefix invariants. Both layers are required:

- **IAM policy:** "this application can talk to Object Storage at all"
- **Bucket policy:** "this application can only touch these prefixes with these actions"

## Tooling

[OpenTofu](https://opentofu.org) ≥ 1.7. Same as the AWS module; just a different provider.

```bash
brew install opentofu
```

## Credentials for the provider itself

The provider reads the standard Scaleway env vars:

```bash
export SCW_ACCESS_KEY=<your-access-key>
export SCW_SECRET_KEY=<your-secret-key>
export SCW_DEFAULT_PROJECT_ID=<your-project-id>
export SCW_DEFAULT_ORGANIZATION_ID=<your-organization-id>
```

Or configure `~/.config/scw/config.yaml` (see `scw init`). The HCL deliberately doesn't pin these so secrets stay out of the repo.

## Apply

```bash
cd deploy/iac/opentofu/scaleway
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars       # set environment, project_id, region

tofu init
tofu plan
tofu apply
```

## Pull per-stage access keys into k8s Secrets

Same shape as the AWS module — the script from `../aws/README.md` works unchanged, just point at this directory:

```bash
cd deploy/iac/opentofu/scaleway
tofu output -json stage_credentials > /tmp/stage-creds.json
# ... rest of the loop is identical to the AWS instructions
```

App env vars also stay the same (`SANITIZER_S3_ACCESS_KEY` etc.) — the worker yamls don't know which cloud minted the credentials.

## App config diffs vs AWS

The only differences in `application.yaml`:

| Field | AWS | Scaleway |
|---|---|---|
| `objectstore.endpoint` | `https://s3.<region>.amazonaws.com` (or default) | `tofu output bucket_endpoint` → e.g. `https://s3.fr-par.scw.cloud` |
| `objectstore.region` | `us-east-1` | `fr-par` / `nl-ams` / `pl-waw` |
| `objectstore.path-style` | `false` | `false` (Scaleway supports both; virtual-hosted is fine) |

Set those via env vars (`OBJECTSTORE_ENDPOINT`, `OBJECTSTORE_REGION`) so the same image runs on either cloud.

## State

Default backend is local. Promote to remote state by uncommenting the `backend "s3"` block in `versions.tf` and pointing it at a Scaleway Object Storage bucket. Scaleway's S3 compat works with the `s3` backend as long as you set `endpoints.s3` + the `skip_*` flags shown in the comment.

## What this module does NOT cover (yet)

- Customer-managed encryption keys (Scaleway Object Storage supports SSE-S3 server-side; SSE-C is on the roadmap).
- Cross-region replication (Scaleway has it via the API; not yet wrapped in this module).
- Workload identity equivalent — Scaleway's IAM doesn't currently have an OIDC federation story comparable to AWS IRSA. Stuck with long-lived access keys until that lands or you front it with Vault/OpenBao.
