---
"kyora": patch
"@kyora-sh/sdk": patch
---

A refusal the API marks `retryable: false` under a code that is usually transient (for example a `503 no_capacity` for a lifetime no machine allows) is now treated as final. The CLI prints the server's own advice without appending its generic capacity hint ("ask for less or retry later"). Both SDKs class it as `limit` instead of `transient` (Python: a `LimitError`), with `retryable` false, so code that retries transient errors leaves it alone.
