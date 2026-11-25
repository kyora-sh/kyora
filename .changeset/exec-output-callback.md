---
"@kyora-sh/sdk": patch
---

The README spells out the exec output callback's contract, in the TypeScript and the Python SDK alike: `onOutput(stream, chunk)` (Python: `on_output`), on `run` and on `exec.attach`, gets `"stdout"` or `"stderr"` and the bytes as they arrive; an async callback is awaited before the next chunk; output past `maxOutputBytes` (Python: `max_output_bytes`) still reaches it; a reattach never hands a chunk over twice, and output dropped while nothing was attached is marked in `truncated`; a throw ends the call at once while the command keeps running.
