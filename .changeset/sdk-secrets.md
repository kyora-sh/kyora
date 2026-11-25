---
"@kyora-sh/sdk": minor
---

Account secrets in the TypeScript and the Python SDK: `kyora.secrets` lists, gets, creates, rotates and deletes secrets (never their values), and creates, updates and deletes their bindings (the egress broker injects the secret into requests to a host) and deliveries (sandboxes receive it as an env variable or a file). A sandbox create takes `proxySecrets` (Python: `proxy_secrets`), and the error catalog gains `delivery_exists`, `not_deliverable`, `secret_changed` and `secret_exists`.
