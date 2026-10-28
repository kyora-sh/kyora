---
"@kyora-sh/sdk": minor
---

`kyora.pages` publishes a bucket prefix as a static site (`publish`, which repoints a page you hold at once), and lists, gets, deletes and logs in to pages. `kyora.domains` serves one of your public URL names or public pages on a hostname of yours (`create`, with the DNS records to add), and lists, gets and deletes domains. A delete answers `false` when the page or domain was already gone. The same helpers land in the Python SDK.
