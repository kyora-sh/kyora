---
"kyora": minor
---

`kyora vms snapshot <sandbox>`, `kyora vms snapshot ls | show | rm` and `kyora vms restore <snap>` take, list, delete and restore snapshots; `kyora vms ls --label key=value` filters by label. `VmsClient` gains `snapshot`, `snapshots`, `getSnapshot`, `deleteSnapshot`, `restore`, `expose`, `ports`, `unexpose`, `releaseName`, and `list({ labels, limit, cursor })`, which follows `next_cursor`.
