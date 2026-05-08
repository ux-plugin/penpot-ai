# Per-stage MinIO / S3 policies

Defense-in-depth for the ingestion pipeline. Each stage gets its own access key bound to a policy that allows **only the operations that stage actually performs** on the prefixes it actually touches. A compromised key from one stage cannot read or destroy data owned by another stage.

| Stage | Policy file | Reads | Writes | Deletes |
|---|---|---|---|---|
| Ingest API | `ingest-api.json` | — | `raw/*` | — |
| Sanitizer | `sanitizer.json` | `raw/*`, `quarantine/*` | `quarantine/*` | `raw/*`, `quarantine/*` |
| Anonymizer | `anonymizer.json` | `raw/*`, `anon/*` | `anon/*` | — |
| Processor | `processor.json` | `anon/*` | — | — |

**Key invariants the policies enforce:**

- Ingest API can never read what was just written. Compromise → attacker can poison data but not exfiltrate.
- Anonymizer cannot delete `raw/`. Eviction is the sanitizer's job, gated by the `RAW_PROCESSED` event. Anonymizer can't bypass the two-phase delete.
- Processor is read-only. Inference / training code cannot mutate the corpus.
- No stage has access to other stages' prefixes.

## Format

JSON files use AWS S3 IAM policy syntax. MinIO accepts the same shape via `mc admin policy create`. AWS users can apply them as bucket-attached policies via their existing IaC tooling (OpenTofu, Pulumi, etc).

ARN literals reference the dev bucket name (`zoetrope-data`). Production deploys should template the bucket name through their IaC layer rather than checking in env-specific copies.

## Local dev

`docker-compose.yaml`'s `minio-init` service applies these on every `up` — see the entrypoint script. Per-stage credentials are derived from env vars (`SANITIZER_S3_ACCESS_KEY` etc.); defaults are committed in `.env.dev` for zero-config local boot.

## Production

These JSON files are the source of truth. Reference them from your IaC tool of choice. Example OpenTofu sketch:

```hcl
resource "aws_iam_policy" "sanitizer" {
  name   = "ingest-pipeline-sanitizer"
  policy = file("${path.module}/../minio-policies/sanitizer.json")
}
```
