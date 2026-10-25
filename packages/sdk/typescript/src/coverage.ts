import type { OperationId } from "./generated/operations.js"

/**
 * Which SDK method sends each operation of the spec, or why none does yet. coverage.test.ts fails
 * on an operation missing here, an entry for an operation the spec no longer has, and a method that
 * does not exist. Every operation is also reachable through `kyora.call(operationId, ...)`.
 */
export type Coverage = { method: string } | { notYet: string }

const DOMAINS = "custom domains: kyora.call() until a helper lands"
const PAGES = "static pages: kyora.call() until a helper lands"
const COMPUTER = "computer use and live views: a later release"
const TERMINALS = "interactive terminals need a WebSocket client: a later release"
const IMAGES = "account images are built with the kyora CLI: a later release"
const STORAGE = "object storage speaks S3 too; kyora.call() until a helper lands"

export const COVERAGE: Record<OperationId, Coverage> = {
  getHealth: { method: "health" },
  listRegions: { method: "regions" },
  getMe: { method: "me" },
  setDefaultRegion: { method: "setDefaultRegion" },
  getUsage: { method: "usage" },
  listTokens: { method: "tokens.list" },
  createToken: { method: "tokens.create" },
  deleteToken: { method: "tokens.delete" },
  listOrgTokens: { method: "tokens.list" },
  createOrgToken: { method: "tokens.create" },
  deleteOrgToken: { method: "tokens.delete" },

  createSandbox: { method: "sandboxes.create" },
  listSandboxes: { method: "sandboxes.list" },
  getSandbox: { method: "sandboxes.get" },
  updateSandbox: { method: "sandboxes.update" },
  deleteSandbox: { method: "sandboxes.delete" },
  resolveSandbox: { method: "sandboxes.resolve" },
  getQueueTicket: { method: "sandboxes.ticket" },
  cancelQueueTicket: { method: "sandboxes.cancelTicket" },
  setSandboxNetwork: { method: "sandboxes.setNetwork" },

  execCommand: { method: "exec.run" },
  attachExec: { method: "exec.attach" },
  cancelExec: { method: "exec.cancel" },

  pushFiles: { method: "files.uploadTar" },
  pullFiles: { method: "files.download" },
  createUpload: { method: "files.uploadTar" },
  uploadPart: { method: "files.uploadTar" },
  completeUpload: { method: "files.uploadTar" },
  abortUpload: { method: "files.uploadTar" },

  createSnapshot: { method: "snapshots.create" },
  listSnapshots: { method: "snapshots.list" },
  getSnapshot: { method: "snapshots.get" },
  deleteSnapshot: { method: "snapshots.delete" },

  exposePort: { method: "ports.expose" },
  listSandboxPorts: { method: "ports.list" },
  unexposePort: { method: "ports.unexpose" },
  createPortLogin: { method: "ports.login" },
  listPorts: { method: "ports.held" },
  deletePort: { method: "ports.release" },

  createDomain: { notYet: DOMAINS },
  listDomains: { notYet: DOMAINS },
  getDomain: { notYet: DOMAINS },
  deleteDomain: { notYet: DOMAINS },

  publishPage: { notYet: PAGES },
  listPages: { notYet: PAGES },
  getPage: { notYet: PAGES },
  deletePage: { notYet: PAGES },
  createPageLogin: { notYet: PAGES },

  computerAction: { notYet: COMPUTER },
  streamComputer: { notYet: COMPUTER },
  createShare: { notYet: COMPUTER },
  listShares: { notYet: COMPUTER },
  deleteShare: { notYet: COMPUTER },
  getShare: { notYet: COMPUTER },
  getShareFrame: { notYet: COMPUTER },

  openTerminal: { notYet: TERMINALS },
  listTerminalSessions: { notYet: TERMINALS },
  createTerminalSession: { notYet: TERMINALS },
  deleteTerminalSession: { notYet: TERMINALS },

  listImages: { notYet: IMAGES },
  createImage: { notYet: IMAGES },
  getImageUsage: { notYet: IMAGES },
  getImage: { notYet: IMAGES },
  deleteImage: { notYet: IMAGES },
  uploadImageChunk: { notYet: IMAGES },
  commitImage: { notYet: IMAGES },

  listBuckets: { notYet: STORAGE },
  createBucket: { notYet: STORAGE },
  getBucket: { notYet: STORAGE },
  deleteBucket: { notYet: STORAGE },
  getBucketCors: { notYet: STORAGE },
  setBucketCors: { notYet: STORAGE },
  deleteBucketCors: { notYet: STORAGE },
  presignObject: { notYet: STORAGE },
  listObjects: { notYet: STORAGE },
  getObject: { notYet: STORAGE },
  headObject: { notYet: STORAGE },
  putObject: { notYet: STORAGE },
  multipartObject: { notYet: STORAGE },
  deleteObject: { notYet: STORAGE },
  listStorageKeys: { notYet: STORAGE },
  createStorageKey: { notYet: STORAGE },
  deleteStorageKey: { notYet: STORAGE },
  getStorageAudit: { notYet: STORAGE },
}
