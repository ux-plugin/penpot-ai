# Kubernetes manifests

Split-pod deploy for the ingestion pipeline. Each Spring Boot module ships as its own image and Deployment so they scale independently and can be evicted/restarted without affecting the others.

```
api          ─ HTTP ingestion endpoint (POST /v1/ingest/...)
sanitizer    ─ ingest.raw → ingest.sanitized | ingest.quarantine
anonymizer   ─ ingest.sanitized → ingest.anon + ingest.raw.processed
processor    ─ ingest.anon → (v0 noop)
```

## Layout

| File | Purpose |
|---|---|
| `configmap.yaml` | Shared env (Redis URL, MinIO endpoint, log level). Update once, all pods pick it up on next rollout. |
| `secret.example.yaml` | Templates for cross-cutting secrets + four per-stage S3 credential Secrets. **Do not commit realized files.** |
| `api.yaml` | api Deployment + ClusterIP Service (port 8080). Liveness + readiness probes hit `/actuator/health/{liveness,readiness}`. |
| `sanitizer.yaml` | sanitizer Deployment. No Service — internal worker. |
| `anonymizer.yaml` | anonymizer Deployment. No Service. |
| `processor.yaml` | processor Deployment. No Service. |

**Secret layout:** the shared `ingest-pipeline-shared-secrets` carries DB/OAuth/AI credentials that every pod needs. Each stage additionally pulls in its own `<stage>-s3-creds` Secret holding the S3 access key bound to that stage's IAM policy. The keys are produced by the OpenTofu module under `../iac/opentofu/` — see that module's README for the `tofu output → kubectl create secret` flow. A compromised pod leaks only the stage's prefix-scoped credential, not a shared root.

Workers do not expose a Service — they are pure stream consumers. The actuator port is exposed only for the kubelet probes.

## Prerequisites

- A running Redis with AOF (`appendonly yes`) — see top-level `docker-compose.yaml` for the canonical config. Required so streams + sanitizer state survive a Redis pod restart.
- A running Postgres with the `figma_plugin` schema (Liquibase migrations run from the api pod on first start).
- An S3 bucket plus four per-stage IAM users provisioned by `deploy/iac/opentofu/`. That module also applies the prefix-scoped lifecycle rules (`raw/` 1d, `quarantine/` 7d, `anon/` 90d).

## Apply

```bash
kubectl apply -f configmap.yaml
kubectl apply -f secret.example.yaml   # AFTER editing with real values
kubectl apply -f api.yaml
kubectl apply -f sanitizer.yaml
kubectl apply -f anonymizer.yaml
kubectl apply -f processor.yaml
```

## Scaling

Workers use Redis Streams consumer groups, so multiple replicas of the same worker share work without coordination — bump `replicas:` in the Deployment to scale.

The api pod is stateless behind the ClusterIP Service; HPA on CPU/RPS works as expected.
