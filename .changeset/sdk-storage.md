---
"@kyora-sh/sdk": minor
---

`kyora.storage` covers object storage: `buckets` (list, create, get, delete, and CORS with `cors`, `setCors`, `clearCors`; a `force` delete removes the bucket's objects first, calling again until kyora answers it deleted), `objects` (list a page or `iterate` every object under a prefix, `get` the bytes, `getStream`, `head`, `put` one PUT up to 64 MiB and a multipart upload past that, aborted if any part fails, `delete`, and `presign` a URL), `keys` (S3 keys: list, create, revoke) and `audit()`. The same helpers land in the Python SDK (`set_cors`, `clear_cors`, `get_stream`).
