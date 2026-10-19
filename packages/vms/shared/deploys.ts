export interface DeployResources { vcpus: number; memoryMb: number; diskGb: number }
export interface DeploySpec {
  image: string
  build: { command: string; resources: DeployResources; timeoutSeconds: number }
  processes: Record<string, string>
  port: number
  health: { path: string; timeoutSeconds: number }
  resources: DeployResources
  region?: string
  egress: string[]
  drainSeconds: number
}
export type DeploymentState = "queued" | "building" | "starting" | "live" | "failed" | "canceled" | "retired"
export interface ProjectCreate { repo: string; name?: string; productionBranch?: string; region?: string }
export interface DeploymentCreate { environment?: "production"; ref?: string; sha?: string }
export interface DeployProject {
  id: string
  accountId: string
  name: string
  installationId: number
  repoId: number
  repoFullName: string
  productionBranch: string
  region: string | null
  createdAt: number
  deletedAt: number | null
}
export interface DeployEvent { at: number; kind: string; detail: string | null }
export interface Deployment {
  id: string
  environment: "production"
  sha: string
  ref: string
  trigger: "push" | "cli"
  state: DeploymentState
  sequence: number
  releaseId: string | null
  buildSandbox: string | null
  runtimeSandbox: string | null
  error: { code: string; message: string } | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
  expiresAt: number | null
}
export interface ProjectView extends DeployProject { url: string; liveDeployment: string | null }
export interface DeploymentView extends Deployment { events: DeployEvent[]; url: string; logsReady?: boolean; logTail?: string }
export interface ProjectList { projects: ProjectView[] }
export interface DeploymentList { deployments: Deployment[] }
export interface DeployPush {
  projectId: string
  repoId: number
  installationId: number
  ref: string
  before: string
  after: string
  pusher: string
  deliveryId: string
}
