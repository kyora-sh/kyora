---
"@kyora-sh/sdk": minor
---

Account secrets in the TypeScript and the Python SDK: `kyora.secrets` lists, gets, creates, rotates and deletes secrets (never their values), and creates, updates and deletes their bindings (code in a sandbox created with `proxySecrets` sends its request to kyora's egress broker at `$KYORA_EGRESS_URL/<binding id>/<path>`, which adds the secret and passes it on to the binding's host; a request sent straight to the host gets nothing added) and deliveries (sandboxes receive it as an env variable or a file). A sandbox create takes `secrets` (the deliveries it receives) and `proxySecrets` (Python: `proxy_secrets`), and the error catalog gains `delivery_exists`, `not_deliverable`, `secret_changed`, `secret_exists` and `secret_not_delivered`.
