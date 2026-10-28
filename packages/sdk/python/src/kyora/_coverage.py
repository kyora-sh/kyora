"""Which SDK method sends each operation of the spec, or why none does yet; the same split as the
TypeScript SDK's coverage.ts. Every operation is also reachable through `kyora.call(operation_id, ...)`."""

from __future__ import annotations

from typing import TypedDict


class Coverage(TypedDict, total=False):
    method: str
    not_yet: str


DOMAINS = "custom domains: kyora.call() until a helper lands"
PAGES = "static pages: kyora.call() until a helper lands"
COMPUTER = "computer use and live views: a later release"
TERMINALS = "interactive terminals need a WebSocket client: a later release"
IMAGES = "account images are built with the kyora CLI: a later release"

COVERAGE: dict[str, Coverage] = {
    "getHealth": {"method": "health"},
    "listRegions": {"method": "regions"},
    "getMe": {"method": "me"},
    "setDefaultRegion": {"method": "set_default_region"},
    "getUsage": {"method": "usage"},
    "listTokens": {"method": "tokens.list"},
    "createToken": {"method": "tokens.create"},
    "deleteToken": {"method": "tokens.delete"},
    "listOrgTokens": {"method": "tokens.list"},
    "createOrgToken": {"method": "tokens.create"},
    "deleteOrgToken": {"method": "tokens.delete"},
    "createSandbox": {"method": "sandboxes.create"},
    "listSandboxes": {"method": "sandboxes.list"},
    "getSandbox": {"method": "sandboxes.get"},
    "updateSandbox": {"method": "sandboxes.update"},
    "deleteSandbox": {"method": "sandboxes.delete"},
    "resolveSandbox": {"method": "sandboxes.resolve"},
    "getQueueTicket": {"method": "sandboxes.ticket"},
    "cancelQueueTicket": {"method": "sandboxes.cancel_ticket"},
    "setSandboxNetwork": {"method": "sandboxes.set_network"},
    "execCommand": {"method": "exec.run"},
    "attachExec": {"method": "exec.attach"},
    "cancelExec": {"method": "exec.cancel"},
    "pushFiles": {"method": "files.upload_tar"},
    "pullFiles": {"method": "files.download"},
    "createUpload": {"method": "files.upload_tar"},
    "uploadPart": {"method": "files.upload_tar"},
    "completeUpload": {"method": "files.upload_tar"},
    "abortUpload": {"method": "files.upload_tar"},
    "createSnapshot": {"method": "snapshots.create"},
    "listSnapshots": {"method": "snapshots.list"},
    "getSnapshot": {"method": "snapshots.get"},
    "deleteSnapshot": {"method": "snapshots.delete"},
    "exposePort": {"method": "ports.expose"},
    "listSandboxPorts": {"method": "ports.list"},
    "unexposePort": {"method": "ports.unexpose"},
    "createPortLogin": {"method": "ports.login"},
    "listPorts": {"method": "ports.held"},
    "deletePort": {"method": "ports.release"},
    "createDomain": {"not_yet": DOMAINS},
    "listDomains": {"not_yet": DOMAINS},
    "getDomain": {"not_yet": DOMAINS},
    "deleteDomain": {"not_yet": DOMAINS},
    "publishPage": {"not_yet": PAGES},
    "listPages": {"not_yet": PAGES},
    "getPage": {"not_yet": PAGES},
    "deletePage": {"not_yet": PAGES},
    "createPageLogin": {"not_yet": PAGES},
    "computerAction": {"not_yet": COMPUTER},
    "streamComputer": {"not_yet": COMPUTER},
    "createShare": {"not_yet": COMPUTER},
    "listShares": {"not_yet": COMPUTER},
    "deleteShare": {"not_yet": COMPUTER},
    "getShare": {"not_yet": COMPUTER},
    "getShareFrame": {"not_yet": COMPUTER},
    "openTerminal": {"not_yet": TERMINALS},
    "listTerminalSessions": {"not_yet": TERMINALS},
    "createTerminalSession": {"not_yet": TERMINALS},
    "deleteTerminalSession": {"not_yet": TERMINALS},
    "listImages": {"not_yet": IMAGES},
    "createImage": {"not_yet": IMAGES},
    "getImageUsage": {"not_yet": IMAGES},
    "getImage": {"not_yet": IMAGES},
    "deleteImage": {"not_yet": IMAGES},
    "uploadImageChunk": {"not_yet": IMAGES},
    "commitImage": {"not_yet": IMAGES},
    "listBuckets": {"method": "storage.buckets.list"},
    "createBucket": {"method": "storage.buckets.create"},
    "getBucket": {"method": "storage.buckets.get"},
    "deleteBucket": {"method": "storage.buckets.delete"},
    "getBucketCors": {"method": "storage.buckets.cors"},
    "setBucketCors": {"method": "storage.buckets.set_cors"},
    "deleteBucketCors": {"method": "storage.buckets.clear_cors"},
    "presignObject": {"method": "storage.objects.presign"},
    "listObjects": {"method": "storage.objects.list"},
    "getObject": {"method": "storage.objects.get"},
    "headObject": {"method": "storage.objects.head"},
    "putObject": {"method": "storage.objects.put"},
    "multipartObject": {"method": "storage.objects.put"},
    "deleteObject": {"method": "storage.objects.delete"},
    "listStorageKeys": {"method": "storage.keys.list"},
    "createStorageKey": {"method": "storage.keys.create"},
    "deleteStorageKey": {"method": "storage.keys.revoke"},
    "getStorageAudit": {"method": "storage.audit"},
}
