---
"@kyora-sh/sdk": patch
---

The READMEs spell out the exec output callback's contract: `onOutput(stream, chunk)` (Python: `on_output`) gets `"stdout"` or `"stderr"` and the bytes as they arrive, an async callback is awaited before the next chunk, output past `maxOutputBytes` (Python: `max_output_bytes`) still reaches it, a reattach never hands a chunk over twice, and a throw ends the call at once while the command keeps running under its key. The same text lands in the Python SDK's README.
