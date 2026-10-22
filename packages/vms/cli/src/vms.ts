import { userEgressAllow } from "@kyora-sh/hostnames"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { NETWORKS, VERSION, VmsClient, type CreateSpec, type ExecRequest, type Network } from "./api"
import { completion, completionNames } from "./completion"
import { confirmAll, ergonomicCommand, SIZES } from "./ergonomics"
import { resolveDestructiveTarget, resolveTarget, sandboxArgs, validName } from "./names"
import { computer, computerAction, ComputerUsage, parseDisplay, parseScale, screenshot } from "./computer"
import { imageCommand, isImageId } from "./account-images"
import { isPinnedRef, lockedImage } from "./image-refs"
import { checkUrl, loadConfig } from "./config"
import { gitMax, type HistoryOptions } from "./history"
import { login, logout, whoami } from "./login"
import { orgList, orgUse } from "./orgs"
import { FAILED, json, note, printJson, write } from "./output"
import { regions } from "./regions"
import { usageCommand } from "./usage"
import { topCommand } from "./top"
import { run } from "./run"
import { sessionMain, SessionUsage } from "./sessions/cli"
import { storageMain, StorageUsage } from "./storage"
import { tokensMain, TokenUsage } from "./tokens"
import { create, exec, health, list, nodes, pullPaths, pushDir, remove } from "./session"
import { domainCommand } from "./domains"
import { killSession, listSessions, shell } from "./shell"
import { MAX_SHARDS } from "./shard"
import { remotePath, WORK } from "./transfer"
import { diskGb, memoryMb, parseSeconds, positiveInt } from "./units"

export const HELP = `kyora vms: run commands in disposable VMs

happy path:
  kyora vms new [name] [-- cmd…]            start a fresh VM and enter its shell
  kyora vms ls [name|id-prefix]             your sandboxes, by name
  kyora vms usage [--json]                 monthly spend estimate and spend limit
  kyora vms top [--once|--json]             live usage of your running VMs (--interval 2, --region ID)
  kyora vms attach [name|id-prefix]         back into its main shell (also ssh)
  kyora vms rm <name|id-prefix>… | --all    destroy sandboxes (--all confirms; --yes for scripts)
  kyora vms run [options] -- <cmd…>        upload this directory, run <cmd> in a fresh
                                            sandbox, stream its output, fetch --out, destroy

more commands (every sandbox argument accepts a name, id or unique id prefix):
  kyora vms rename <x> <name>               change a sandbox name
  kyora vms ttl <x> <duration|none>         set total lifetime from creation
  kyora vms completion bash|zsh|fish        shell completions with sandbox names
  kyora vms create [name] [options]         start a sandbox, print its id
  kyora vms network <id> --allow HOST... [--no-registries | --none]
                                            replace allowed hosts, optionally drop registries
                                            --no-registries keeps omitted hosts; --none clears them
                                            unless --allow supplies a replacement
  kyora vms exec <id> [options] -- <cmd…>   run a command in a sandbox
  kyora vms push <id> [dir] [--dest /work]  upload a directory (git-aware, like run; --no-git,
                                            --git, --git-depth, --git-base, --shards too)
  kyora vms pull <id> <path>… [--to dir]    download sandbox paths and unpack them here
  kyora vms screenshot <id> [-o file.png]   a screenshot of a desktop sandbox's screen (--image desktop)
  kyora vms computer <id> <action> [args…]  drive its desktop: left_click 640 400, type "hello", key ctrl+l,
                                            scroll down 5, … (actions under "desktop" below)
  kyora vms shell <id> [-- cmd…]            a terminal in the sandbox: a tmux session that keeps running
                                            when you detach or the network drops (options under "shell")
  kyora vms share <x> screen|tty:SESSION   show a live run to your team, view only (--ttl 2h); another X display
                                            with --socket PATH [--xauthority PATH], a constrained viewer --quality low;
                                            --mode broadcast for larger audiences, --mode vnc (default);
                                            a broadcast's --keys full shows viewers the characters typed (masked by default);
                                            --record BUCKET[/PREFIX] keeps it as fMP4 and HLS in your bucket (a broadcast),
                                            in segments of --segment-seconds N (2-10, default 10)
  kyora vms share <x> --list|--revoke ID   list active shares or revoke one and close its viewers
  kyora vms expose <id> <port> [--name label] [--public] [--trusted]   print a private URL through kyora cloud
  kyora vms expose [<id>] --list            list exposed ports, or all held names
  kyora vms unexpose [<id>] <label>         release a name (30-day cooldown for other accounts)
  kyora vms domain add <hostname> --to <label> [--dcv http|txt]
                                            serve a public name on your own domain: prints the DNS
                                            records to add (a CNAME to custom.kyora.run); --page <name>
                                            instead of --to serves one of your public pages
  kyora vms domain ls | status <hostname> | rm <hostname>
                                            your custom domains and their current status
  kyora vms resize <id> --disk <size>       grow a running sandbox disk, for example --disk 60G
  kyora vms health                          is the host up, is the key accepted
  kyora vms regions [default <id>|global]   kyora cloud's regions, what is free in each, and
                                            where your creates go; make one your default
  kyora vms images [--json]                 fleet image availability
  kyora vms images build <profile> --node <name> | --all   admin: rebuild now
  kyora vms image build [kyora.image.json]  build your image from a spec in a throwaway sandbox and store it
                                            as name@N (the same spec, files and base: reused at once); --json,
                                            --name N, --region R; create --image name[@N] boots it
  kyora vms image lock [kyora.image.json]   pin the newest version in kyora.image.lock: create --image name
                                            here boots the pinned one
  kyora vms image ls | versions <name> | rm <name@N|img_…> | usage
                                            your images by name, one name's versions, delete one, storage
  kyora vms image push <file.ext4> --name N [--region R]   store an ext4 you built yourself as name's next version
  kyora vms nodes                           kyora cloud's machines and what is free on them
  kyora vms session …                       move a Claude Code session to a VM and back
                                            (also \`kyora session …\`; \`kyora vms session --help\`)
  kyora vms storage …                       private object storage: buckets, put, get, ls, rm,
                                            presign (\`kyora vms storage --help\`)

account (kyora cloud):
  kyora vms login [--url URL]               sign in through the browser; the token is kept
                                            in ~/.config/kyora/credentials.json (0600)
  kyora vms login --org ORG                 a token that acts as an org you're in (its sandboxes,
                                            caps and tokens are shared by its members)
  kyora vms org ls                          your orgs, and which account commands act as
  kyora vms org use <org>|personal          act as that org from now on (or as yourself again)
  kyora vms logout [--url URL]              forget the tokens for that server here
  kyora vms whoami                          whose token is in use
  kyora vms tokens create|ls|revoke         scoped API tokens (tokens --help for options)

sandbox (run, create, new):
  --no-share        never allow view share links, for this sandbox or restores of its snapshots
  --name NAME       sandbox name: 1-32 characters of a-z, 0-9 and - (else a friendly name)
  --size s|m|l|xl  CPU/RAM: 2/4G, 4/8G, 8/16G, 16/32G; --cpus/--memory override either
                    new defaults: network registries, server TTL, idle 1h
  --network MODE    none (default): no network at all
                    registries: package registries only (crates.io, npm, PyPI, GitHub…)
                    open: the internet, if your key allows it
  --allow HOST      repeatable, up to 32 exact hostnames or *.suffix (IDNA supported)
                    none + allow: allowlist only; registries + allow: both; open refuses allow
                    public URL labels must be exact for non-admins
                    TLS SNI filtering cannot prevent HTTP Host fronting between names sharing
                    a wildcard certificate, e.g. *.kyora.run, through any allowed name
  --cpus N          vCPUs (default 4)
  --allocated-cpus N Fractional CPU allocation (default --cpus)
  --cpu-limit N     CPU cap fraction (0.05-1, default 1)
  --max-memory SIZE Memory ceiling (default --memory)
  --autoscale       Grow and shrink memory within the ceiling
  --memory SIZE     RAM, e.g. 16G (default 8G)
  --disk SIZE       scratch disk behind /work, e.g. 60G (default 30G)
  --ttl DURATION    lifetime, e.g. 2h or none (default 8h)
  --idle DURATION   idle timeout or none (default 20m; none with --ttl none)
  --image NAME      the guest image, e.g. desktop (default: $KYORA_VMS_IMAGE, else the machine's
                    default image); desktop for a screen to drive (computer use); one of your
                    account's images as name (its newest; the version kyora.image.lock pins, if
                    this directory has one), name@N, name@sha256:… or img_… (kyora vms image ls)
  --display WxH     a desktop image's screen size, e.g. 1024x768 (default 1280x800, at most 2560x1440)
  --region ID       kyora cloud: run in this region and only there (eu, us, apac; default:
                    $KYORA_VMS_REGION, else your default). global, or none: a region is
                    chosen automatically, nearest first (a fallback is said on stderr)
  --wait DURATION   kyora cloud: when capacity is unavailable, wait for up to this long
                    (default 15m, the most it allows), printing your place on stderr;
                    Ctrl-C cancels the create
  --no-wait         fail at once when capacity is unavailable (exit 125)

command (run, exec):
  --timeout DURATION  kill the command after this long, e.g. 45m (exit 124); a minute past
                      that, kyora stops waiting for it whatever its stream does (124 too)
  -e, --env K=V       set a variable for the command; --env K passes your own $K
  --cwd DIR           working directory, relative to /work (default /work)
  --stdin             send this process's stdin to the command

run:
  --dir DIR         what to upload (default .): in a git repo the tracked files plus
                    untracked ones .gitignore does not exclude, else everything but
                    .git, node_modules, target, .venv and dist
  --no-git          walk --dir as if it were not a repo (gitignored files go up too)
  --git             also send the history (a git bundle) and set up /work/.git: HEAD, its
                    branch, origin (no credentials), and your index, so git status and
                    git diff show what they show here. Your .git itself never goes up. All
                    of HEAD's history unless bounded, at most 1 GiB (KYORA_VMS_GIT_MAX)
  --git-depth N     only the last N commits of HEAD (implies --git)
  --git-base REF    REF too (e.g. origin/main) and the commits from it and HEAD back to
                    their merge base, for \`git diff REF\`, \`git log REF..\` (implies --git)
  --shards N        split the upload into N archives that go up and unpack side by side
                    (1-${MAX_SHARDS}; cloud default: one per 256 MiB, up to 8; direct server default: 1)
  -o, --out PATH    download PATH (relative to /work) afterwards, whatever the exit code
  --to DIR          where --out lands (default --dir), laid out as under /work
  --keep            keep the sandbox and print its id instead of destroying it

shell (a persistent terminal):
  --name NAME       the session (default main); another name is another session
  -- cmd…           run cmd in a new window of the session (claude, htop, vim…), once
  --view            watch it: your keys go nowhere
  --list            the sandbox's sessions, attached or not, and what runs in them
  --kill NAME       end a session and everything in it
  -e, --env K=V     and --cwd DIR: for the window cmd runs in
  --clipboard       let the sandbox set your terminal's clipboard (OSC 52; also KYORA_VMS_CLIPBOARD=1).
                    Off, those sequences are taken out of what reaches your terminal
                    ~. after Enter detaches (the session keeps running; tmux's C-b d does too); a
                    dropped connection reattaches by itself, and the screen is redrawn. A session
                    something runs in keeps the sandbox from idling out, within its --ttl

desktop (screenshot, computer; the Anthropic computer-use tool's actions):
  actions           screenshot · zoom x0 y0 x1 y1 · left_click|right_click|middle_click|double_click|
                    triple_click [x y] · left_click_drag x0 y0 x1 y1 · mouse_move x y ·
                    left_mouse_down|left_mouse_up [x y] · cursor_position · scroll up|down|left|right
                    amount [x y] · type text… · key combo… (ctrl+s, Return, alt+Tab) ·
                    hold_key combo seconds · wait seconds · info; text that starts with - goes after --
  --region x,y,w,h  screenshot: only that part of the screen, at full resolution (a zoom; for
                    run and create, --region is the region to run in)
  --scale F         the screenshot's size times F (0.1-1); coordinates stay the screen's
  --screenshot      computer: a screenshot after the action (once the screen settled, 1 s)
  --modifiers KEYS  computer: keys held for a click, drag or scroll, e.g. shift or ctrl+alt
  --repeat N        computer key: press it N times
  -o, --out FILE    where a screenshot goes (default ./<id>-<time>.png; - for stdout)

  --json            machine-readable output (run and exec: NDJSON events)
  -h, --help        this help
  -v, --version     print the version

exit codes: the remote command's own; 124 when --timeout hit; 128+n when it died
of signal n (130 after Ctrl-C); 125 when kyora itself failed; 123 when the requested image is unavailable.

config: KYORA_VMS_URL, and KYORA_VMS_KEY (a server's kvms_… key) or KYORA_TOKEN (a
kyora cloud kyora_… token), from the environment, else KEY=VALUE lines in
~/.config/kyora-vms/env, else the \`kyora vms login\` for that URL. With nothing set it
is kyora cloud, https://cloud.kyora.sh (a kvms_ key alone still means https://vms.kyora.sh).`

const OPTIONS = {
  dir: { type: "string" },
  network: { type: "string" },
  allow: { type: "string", multiple: true },
  "no-share": { type: "boolean" },
  socket: { type: "string" },
  xauthority: { type: "string" },
  quality: { type: "string" },
  mode: { type: "string" },
  keys: { type: "string" },
  record: { type: "string" },
  "segment-seconds": { type: "string" },
  "no-registries": { type: "boolean" },
  none: { type: "boolean" },
  image: { type: "string" },
  cpus: { type: "string" },
  "allocated-cpus": { type: "string" },
  "cpu-limit": { type: "string" },
  "max-memory": { type: "string" },
  autoscale: { type: "boolean" },
  size: { type: "string" },
  memory: { type: "string" },
  disk: { type: "string" },
  ttl: { type: "string" },
  idle: { type: "string" },
  wait: { type: "string" },
  "no-wait": { type: "boolean" },
  // deprecated: naming a region is strict already
  strict: { type: "boolean" },
  timeout: { type: "string" },
  env: { type: "string", short: "e", multiple: true },
  cwd: { type: "string" },
  stdin: { type: "boolean" },
  out: { type: "string", short: "o", multiple: true },
  to: { type: "string" },
  dcv: { type: "string" },
  page: { type: "string" },
  keep: { type: "boolean" },
  dest: { type: "string" },
  "no-git": { type: "boolean" },
  git: { type: "boolean" },
  "git-depth": { type: "string" },
  "git-base": { type: "string" },
  shards: { type: "string" },
  node: { type: "string" },
  all: { type: "boolean" },
  yes: { type: "boolean" },
  url: { type: "string" },
  org: { type: "string" },
  display: { type: "string" },
  region: { type: "string" },
  scale: { type: "string" },
  screenshot: { type: "boolean" },
  modifiers: { type: "string" },
  repeat: { type: "string" },
  name: { type: "string" },
  private: { type: "boolean" },
  public: { type: "boolean" },
  trusted: { type: "boolean" },
  view: { type: "boolean" },
  list: { type: "boolean" },
  kill: { type: "string" },
  revoke: { type: "string" },
  clipboard: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const

type Option = keyof typeof OPTIONS

const SANDBOX: Option[] = ["no-share", "size", "network", "allow", "cpus", "allocated-cpus", "cpu-limit", "max-memory", "autoscale", "memory", "disk", "ttl", "idle", "image", "display", "region", "strict", "wait", "no-wait"]

/** how long a create waits in line for room on kyora cloud unless told otherwise: the most the server allows */
const DEFAULT_WAIT_S = 15 * 60
const COMMAND: Option[] = ["timeout", "env", "cwd", "stdin"]

/** which flags each verb takes, so a typo'd or misplaced flag fails loudly instead of doing nothing */
const VERBS: Record<string, Option[]> = {
  usage: [],
  run: ["name", ...SANDBOX, ...COMMAND, "dir", "no-git", "git", "git-depth", "git-base", "shards", "out", "to", "keep"],
  create: [...SANDBOX, "name"],
  new: [...SANDBOX, "name", "env", "cwd", "clipboard"],
  attach: ["view", "clipboard"],
  rename: [],
  ttl: [],
  completion: [],
  __complete: [],
  resize: ["disk"],
  network: ["allow", "no-registries", "none"],
  ls: [],
  exec: COMMAND,
  push: ["dest", "no-git", "git", "git-depth", "git-base", "shards"],
  pull: ["to"],
  rm: ["all", "yes"],
  health: [],
  images: ["node", "all"],
  image: ["name", "region"],
  nodes: [],
  regions: [],
  screenshot: ["out", "region", "scale"],
  computer: ["out", "screenshot", "modifiers", "repeat", "scale"],
  expose: ["name", "private", "public", "trusted", "list"],
  unexpose: [],
  domain: ["to", "page", "dcv"],
  shell: ["name", "view", "list", "kill", "env", "cwd", "clipboard"],
  share: ["ttl", "list", "revoke", "socket", "xauthority", "quality", "mode", "keys", "record", "segment-seconds"],
  login: ["url", "org"],
  org: [],
  logout: ["url"],
  whoami: [],
}
const ALIASES: Record<string, string> = { ssh: "attach", list: "ls", destroy: "rm", delete: "rm" }

class UsageError extends Error {}

function usage(message: string): never {
  throw new UsageError(message)
}

const parse = (args: string[]) => parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true })
type Values = ReturnType<typeof parse>["values"]

function parseEnv(pairs: string[] = []): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf("=")
    const name = eq === -1 ? pair : pair.slice(0, eq)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) usage(`--env ${JSON.stringify(pair)}: expected NAME=value or NAME`)
    if (eq === -1) {
      const value = process.env[name]
      if (value === undefined) usage(`--env ${name}: $${name} is not set here`)
      env[name] = value
    } else env[name] = pair.slice(eq + 1)
  }
  return env
}

function sandboxSpec(values: Values): CreateSpec {
  const network = values.network as Network | undefined
  if (network !== undefined && !NETWORKS.includes(network)) usage(`--network must be one of ${NETWORKS.join(", ")}`)
  const spec: CreateSpec = {}
  if (values["no-share"]) spec.shareable = false
  if (values.name !== undefined) spec.name = validName(values.name)
  if (values.size !== undefined) {
    const size = Object.hasOwn(SIZES, values.size) ? SIZES[values.size]! : usage("--size takes s, m, l or xl")
    Object.assign(spec, size)
  }
  if (network) spec.network = network
  if (values.allow !== undefined) {
    if (network === "open") usage("--allow requires --network none or registries")
    try { spec.egressAllow = userEgressAllow(values.allow, true) } catch (error) { usage(error instanceof Error ? error.message : String(error)) }
  }
  if (values.cpus) spec.vcpus = positiveInt(values.cpus, "--cpus")
  for (const [flag, field] of [["allocated-cpus", "allocatedVcpus"], ["cpu-limit", "cpuLimit"]] as const) {
    if (values[flag] !== undefined) {
      const value = Number(values[flag])
      if (!Number.isFinite(value) || value < 0.05) usage(`--${flag} must be at least 0.05`)
      spec[field] = value
    }
  }
  if (values["max-memory"]) spec.maxMemoryMb = memoryMb(values["max-memory"])
  if (values.autoscale) spec.autoscale = true
  if (values.memory) spec.memoryMb = memoryMb(values.memory)
  if (values.disk) spec.diskGb = diskGb(values.disk)
  if (values.ttl) spec.ttlSeconds = values.ttl === "none" ? 0 : parseSeconds(values.ttl, "--ttl")
  if (values.idle) spec.idleSeconds = values.idle === "none" ? 0 : parseSeconds(values.idle, "--idle")
  // an agent's wrapper sets KYORA_VMS_IMAGE once; --image still wins for one call
  const image = values.image ?? (process.env.KYORA_VMS_IMAGE?.trim() || undefined)
  if (image !== undefined) {
    if (!IMAGE_PATTERN.test(image) && !isImageId(image) && !isPinnedRef(image)) usage(`${values.image === undefined ? "KYORA_VMS_IMAGE" : "--image"} must be a short lowercase name, e.g. desktop, or one of your account's images: name, name@N, name@sha256:… or img_…`)
    // a name kyora.image.lock pins here boots the pinned version, never whatever is newest
    try { spec.image = lockedImage(image, process.cwd(), note) } catch (error) { usage(error instanceof Error ? error.message : String(error)) }
  }
  if (values.display !== undefined) spec.display = parseDisplay(values.display)
  // like the image: an agent's wrapper sets KYORA_VMS_REGION once, --region wins for one call
  const region = values.region ?? (process.env.KYORA_VMS_REGION?.trim() || undefined)
  if (region !== undefined) {
    if (!REGION_PATTERN.test(region)) usage(`${values.region === undefined ? "KYORA_VMS_REGION" : "--region"} must be a region id, e.g. eu, us or apac, or global`)
    spec.region = region
  }
  if (values.strict) note("--strict does nothing any more: --region <id> keeps a create in that region, and none (or --region global) lets it run in the nearest region with room")
  return spec
}

/** an org's handle on kyora cloud */
const ORG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/

/** kyora cloud's region ids */
const REGION_PATTERN = /^[a-z][a-z0-9-]{1,23}$/

/** kyora-vmd's and the platform's rule for image names */
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** seconds a create may wait in line for room: --wait, 0 for --no-wait, else the default */
function waitSeconds(values: Values): number {
  if (values["no-wait"] && values.wait !== undefined) usage("--wait and --no-wait don't go together")
  if (values["no-wait"]) return 0
  return values.wait === undefined ? DEFAULT_WAIT_S : parseSeconds(values.wait, "--wait")
}

/** how an upload is split and sent: --shards, and KYORA_VMS_PARTS_IN_FLIGHT for trying more (or fewer) parts in flight than the default */
function uploadOptions(values: Values): { shards?: number; partsInFlight?: number } {
  const options: { shards?: number; partsInFlight?: number } = {}
  if (values.shards !== undefined) {
    options.shards = positiveInt(values.shards, "--shards")
    if (options.shards > MAX_SHARDS) usage(`--shards takes at most ${MAX_SHARDS}`)
  }
  const parts = process.env.KYORA_VMS_PARTS_IN_FLIGHT?.trim()
  if (parts) {
    options.partsInFlight = positiveInt(parts, "KYORA_VMS_PARTS_IN_FLIGHT")
    if (options.partsInFlight > 32) usage("KYORA_VMS_PARTS_IN_FLIGHT takes at most 32")
  }
  return options
}

/** --git and what bounds it; null when none of them was given */
function historyOptions(values: Values): HistoryOptions | null {
  const depth = values["git-depth"]
  const base = values["git-base"]
  if (!values.git && depth === undefined && base === undefined) return null
  if (values["no-git"]) usage("--git sends the history git has, so it does not go with --no-git")
  const options: HistoryOptions = { maxBytes: gitMax() }
  if (depth !== undefined) options.depth = positiveInt(depth, "--git-depth")
  if (base !== undefined) {
    if (!base.trim() || base.startsWith("-")) usage(`--git-base takes a commit or ref, such as origin/main, not ${JSON.stringify(base)}`)
    options.base = base.trim()
  }
  return options
}

async function execRequest(values: Values, cmd: string[]): Promise<ExecRequest> {
  if (cmd.length === 0) usage("no command: put it after --, e.g. `kyora vms run -- cargo build --release`")
  const request: ExecRequest = { cmd, cwd: values.cwd ? remotePath(values.cwd) : WORK }
  const env = parseEnv(values.env)
  if (env) request.env = env
  if (values.timeout) request.timeoutSeconds = parseSeconds(values.timeout, "--timeout")
  if (values.stdin) request.stdin = await Bun.stdin.text()
  return request
}

/** `kyora vms …`, which `kyora-vms …` also is */
export async function vmsMain(argv: string[]): Promise<number> {
  if (argv[0] === "top") return topCommand(argv.slice(1))
  // kyora session …: a command group of its own
  if (argv[0] === "session") return sessionMain(argv.slice(1))
  // kyora vms storage …: managed object storage
  if (argv[0] === "storage") return storageMain(argv.slice(1))
  if (argv[0] === "tokens") return tokensMain(argv.slice(1))
  const split = argv.indexOf("--")
  const head = split === -1 ? argv : argv.slice(0, split)
  let tail = split === -1 ? null : argv.slice(split + 1)

  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(head)
  } catch (error) {
    const hint = tail === null ? " (options for the remote command go after --)" : ""
    usage(`${(error as Error).message}${hint}`)
  }
  const { values } = parsed
  let [rawVerb, ...positionals] = parsed.positionals
  const bare = !rawVerb && !values.help && !values.version && Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (bare) rawVerb = "ls"
  if (values.version || values.help || !rawVerb || rawVerb === "help") {
    console.log(values.version ? VERSION : HELP)
    return 0
  }

  const verb = ALIASES[rawVerb] ?? rawVerb
  const targets = sandboxArgs(verb, positionals, tail)
  positionals = targets.positionals
  tail = targets.tail
  const allowed = VERBS[verb] ?? usage(`unknown command "${rawVerb}"; run \`kyora vms --help\``)
  for (const name of Object.keys(values) as Option[]) {
    if (name !== "json" && !allowed.includes(name)) usage(`${verb} does not take --${name}`)
  }
  // `computer <id> type -- -n` types "-n": what follows -- is the action's, not kyora's options
  const takesCommand = verb === "run" || verb === "exec" || verb === "computer" || verb === "shell" || verb === "new"
  if (tail !== null && !takesCommand) usage(`${verb} takes no command after --`)
  const asJson = Boolean(values.json)

  if (verb === "completion") {
    if (positionals.length !== 1) usage("completion takes bash, zsh or fish")
    console.log(completion(positionals[0]!))
    return 0
  }

  const config = await loadConfig()
  if (bare && !config.key) {
    console.log(HELP)
    note("run kyora vms login to get started")
    return 0
  }
  const api = new VmsClient(config)

  const ergonomic = await ergonomicCommand(api, { verb, positionals, tail, json: asJson, values, spec: () => sandboxSpec(values), wait: () => waitSeconds(values), env: () => parseEnv(values.env), usage })
  if (ergonomic !== undefined) return ergonomic

  switch (verb) {
    case "usage":
      if (positionals.length) usage("usage takes no arguments")
      return usageCommand(api, asJson)
    case "__complete":
      console.log((await completionNames(api, `${config.url}:${config.key ?? ""}`)).join("\n"))
      return 0
    case "expose": {
      const [id, portText, extra] = positionals
      if (extra || (values.private && values.public) || (values.list ? portText || values.name || values.private || values.public || values.trusted : !id || !portText)) usage("usage: kyora vms expose <sandbox> <port> [--name label] [--public] [--trusted], or expose [<sandbox>] --list")
      if (values.list) {
        const result = await api.call<{ ports: Array<{ label: string; port: number; private: boolean; trusted?: boolean; running?: boolean; url: string }> }>("list exposed ports", "GET", id ? `/v1/sandboxes/${encodeURIComponent(id)}/ports` : "/v1/ports")
        if (asJson) console.log(JSON.stringify(result))
        else for (const port of result.ports) console.log(`${port.url}  ${port.port}  ${port.private ? "private" : "public"}${port.trusted ? "  trusted" : ""}${port.running === false ? "  not running" : ""}`)
      } else {
        const port = positiveInt(portText!, "port")
        if (port > 65535) usage("port must be 1-65535")
        const result = await api.call<{ url: string }>("expose port", "POST", `/v1/sandboxes/${encodeURIComponent(id!)}/ports`, { json: { port, ...(values.name ? { name: values.name } : {}), ...(values.public ? { public: true } : {}), ...(values.trusted ? { trusted: true } : {}) } })
        console.log(asJson ? JSON.stringify(result) : result.url)
      }
      return 0
    }
    case "domain":
      return domainCommand(api, { positionals, to: values.to, page: values.page, dcv: values.dcv, json: asJson }, usage)
    case "unexpose": {
      const [id, label, extra] = positionals
      if (!id || extra) usage("usage: kyora vms unexpose [<sandbox>] <label>")
      await api.call("unexpose port", "DELETE", label ? `/v1/sandboxes/${encodeURIComponent(id)}/ports/${encodeURIComponent(label)}` : `/v1/ports/${encodeURIComponent(id)}`, { accept: [204] })
      if (asJson) console.log(JSON.stringify({ released: true, label: label ?? id }))
      return 0
    }
    case "run": {
      if (tail !== null && positionals.length > 0) usage(`unexpected ${positionals.join(" ")} before --`)
      const dir = resolve(values.dir ?? ".")
      const outs = (values.out ?? []).map((out) => remotePath(out))
      const upload = uploadOptions(values)
      return run(api, {
        dir,
        git: !values["no-git"],
        history: historyOptions(values),
        spec: sandboxSpec(values),
        wait: waitSeconds(values),
        exec: await execRequest(values, tail ?? positionals),
        outs,
        to: resolve(values.to ?? dir),
        keep: Boolean(values.keep),
        json: asJson,
        upload,
      })
    }
    case "exec": {
      const [id, ...rest] = positionals
      if (!id) usage("exec needs a sandbox id: kyora vms exec <id> -- <cmd…>")
      if (tail !== null && rest.length > 0) usage(`unexpected ${rest.join(" ")} before --`)
      const request = await execRequest(values, tail ?? rest)
      return exec(api, await resolveTarget(api, id), request, asJson)
    }
    case "create": {
      if (positionals.length > 1 || (positionals.length > 0 && values.name !== undefined)) usage("usage: kyora vms create [name] [options]")
      const spec = sandboxSpec(values)
      if (positionals.length) spec.name = validName(positionals[0]!)
      return create(api, spec, waitSeconds(values), asJson)
    }
    case "resize": {
      const [id, extra] = positionals
      if (!id || extra || !values.disk) usage("usage: kyora vms resize <id> --disk <size>")
      const sandbox = await api.resize(id, diskGb(values.disk))
      console.log(asJson ? JSON.stringify(sandbox) : `${sandbox.id}: ${sandbox.diskGb}G disk`)
      return 0
    }
    case "network": {
      const [id, extra] = positionals
      if (!id || extra || (values.none && values["no-registries"]) || (!values.none && !values.allow && !values["no-registries"])) usage("usage: kyora vms network <id> --allow HOST... [--no-registries], or --none")
      let hosts: string[] | undefined
      try { hosts = values.allow === undefined ? values.none ? [] : undefined : userEgressAllow(values.allow, true) } catch (error) { usage(error instanceof Error ? error.message : String(error)) }
      const policy = await api.network(id, { ...(hosts ? { egressAllow: hosts } : {}), ...(values.none || values["no-registries"] ? { network: "none" } : {}) })
      console.log(JSON.stringify(policy))
      return 0
    }
    case "ls":
      if (positionals.length > 1) usage("ls takes at most one sandbox id")
      if (bare) {
        const sandboxes = await api.list()
        await list(api, undefined, asJson, sandboxes)
        if (!asJson) console.log(sandboxes.length ? "back in: kyora vms attach <name> · fresh VM: kyora vms new" : "start a fresh VM: kyora vms new [name] · detach with ~. after Enter")
        return 0
      }
      return list(api, positionals.length ? await resolveTarget(api, positionals[0]!) : undefined, asJson)
    case "push": {
      const [id, dir = ".", extra] = positionals
      if (!id || extra) usage("usage: kyora vms push <id> [dir] [--dest /work]")
      const options = {
        dir: resolve(dir),
        git: !values["no-git"],
        dest: remotePath(values.dest ?? WORK),
        upload: uploadOptions(values),
        history: historyOptions(values),
        json: asJson,
      }
      return pushDir(api, id, options)
    }
    case "pull": {
      const [id, ...paths] = positionals
      if (!id || paths.length === 0) usage("usage: kyora vms pull <id> <path>… [--to dir]")
      return pullPaths(api, await resolveTarget(api, id), paths.map((path) => remotePath(path)), resolve(values.to ?? "."), asJson)
    }
    case "rm": {
      if (Boolean(values.all) === (positionals.length > 0)) usage("usage: kyora vms rm <name|id>… or kyora vms rm --all")
      if (values.all) {
        if (!values.yes && !(process.stdin.isTTY && process.stdout.isTTY)) usage("rm --all needs --yes without a TTY")
        const sandboxes = await api.list()
        if (!values.yes && !await confirmAll(sandboxes.length)) return 0
        return remove(api, sandboxes.map((s) => s.id), false, asJson, Object.fromEntries(sandboxes.map((s) => [s.id, s.name ?? s.id])))
      }
      const ids: string[] = []
      const labels: Record<string, string> = {}
      for (const input of positionals) {
        const id = await resolveDestructiveTarget(api, input)
        ids.push(id)
        labels[id] = input
      }
      return remove(api, [...new Set(ids)], false, asJson, labels)
    }
    case "screenshot": {
      const [id, extra] = positionals
      if (!id || extra) usage("usage: kyora vms screenshot <id> [-o file.png] [--region x,y,w,h] [--scale F]")
      if ((values.out ?? []).length > 1) usage("screenshot takes one -o")
      return screenshot(api, await resolveTarget(api, id), { out: values.out?.[0], region: values.region, scale: values.scale, json: asJson })
    }
    case "computer": {
      const [id, name, ...rest] = positionals
      if (!id || !name) usage("usage: kyora vms computer <id> <action> [args…], e.g. computer <id> left_click 640 400")
      if ((values.out ?? []).length > 1) usage("computer takes one -o")
      const repeat = values.repeat === undefined ? undefined : positiveInt(values.repeat, "--repeat")
      const action = computerAction(name, [...rest, ...(tail ?? [])], {
        modifiers: values.modifiers,
        repeat,
        screenshot: Boolean(values.screenshot),
        scale: values.scale === undefined ? undefined : parseScale(values.scale),
      })
      return computer(api, await resolveTarget(api, id), action, { out: values.out?.[0], json: asJson })
    }
    case "share": {
      const [target, stream, extra] = positionals
      if (!target || extra || (values.list && values.revoke) || ((values.list || values.revoke) && (stream || values.ttl))) usage("usage: kyora vms share <sandbox> screen|tty:<session> [--ttl 2h], or --list, or --revoke <id>")
      const tty = stream?.startsWith("tty:") ? stream.slice(4) : undefined
      if (!values.list && !values.revoke && stream !== "screen" && (!tty || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(tty))) usage("share takes screen or tty:<existing-session>")
      const ttlSeconds = values.ttl ? parseSeconds(values.ttl, "--ttl") : undefined
      // another X server in the sandbox, by its socket (kyora checks it when a viewer connects, not now)
      if ((values.socket || values.xauthority || values.quality || values.mode || values.keys || values.record) && stream !== "screen") usage("--socket, --xauthority, --quality, --mode, --keys and --record are a screen share's")
      if (values.mode !== undefined && values.mode !== "vnc" && values.mode !== "broadcast") usage("--mode is vnc (the default: RFB for each viewer) or broadcast (encoded once, for an audience)")
      if (values.keys !== undefined && values.keys !== "masked" && values.keys !== "full") usage("--keys is masked (the default: that a key was pressed, never which) or full (the characters typed)")
      if (values.keys === "full" && values.mode === "vnc") usage("--keys full is a broadcast's: use it with --mode broadcast")
      // a recording of the broadcast into one of your storage buckets, under a prefix: BUCKET or BUCKET/PREFIX (it is a broadcast's own stream)
      if (values.record !== undefined && values.mode === "vnc") usage("--record keeps a broadcast: use it with --mode broadcast (or no --mode)")
      const slash = values.record?.indexOf("/") ?? -1
      // the recording's segment length: shorter, a fresher live playlist (and more objects)
      const segment = values["segment-seconds"]
      if (segment !== undefined && values.record === undefined) usage("--segment-seconds goes with --record")
      if (segment !== undefined && (!/^\d{1,2}$/.test(segment) || Number(segment) < 2 || Number(segment) > 10)) usage("--segment-seconds is a whole number of seconds from 2 to 10 (default 10)")
      const record = values.record === undefined ? undefined : {
        ...(slash < 0 ? { bucket: values.record } : { bucket: values.record.slice(0, slash), ...(values.record.slice(slash + 1) ? { prefix: values.record.slice(slash + 1) } : {}) }),
        ...(segment !== undefined ? { segmentSeconds: Number(segment) } : {}),
      }
      if (record && !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(record.bucket)) usage("--record takes a bucket of yours (kyora vms storage ls), and a prefix in it: BUCKET or BUCKET/PREFIX")
      if (values.xauthority && !values.socket) usage("--xauthority needs --socket")
      for (const [flag, path] of [["--socket", values.socket], ["--xauthority", values.xauthority]] as const) {
        if (path !== undefined && (!path.startsWith("/") || path.split("/").slice(1).some((part) => part === "" || part === "." || part === ".."))) usage(`${flag} takes the absolute path of the X server's ${flag === "--socket" ? "socket" : "xauthority file"}`)
      }
      if (values.quality !== undefined && values.quality !== "high" && values.quality !== "low") usage("--quality is high (the default) or low")
      const display = values.socket ? { socket: values.socket, ...(values.xauthority ? { xauthority: values.xauthority } : {}) } : undefined
      if (ttlSeconds !== undefined && ttlSeconds > 86400) usage("share --ttl is at most 24h")
      if (values.revoke && !/^share_[A-Za-z0-9_-]{16}$/.test(values.revoke)) usage("--revoke takes the share id from --list")
      const id = await (values.revoke ? resolveDestructiveTarget(api, target) : resolveTarget(api, target))
      if (values.list) {
        const listed = await api.listShares(id)
        if (asJson) printJson(listed)
        else for (const share of listed.shares) console.log(`${share.id}  ${share.stream === "tty" ? `tty:${share.session}` : share.display ? `screen:${share.display.socket}` : "screen"}${share.quality === "low" ? " (low)" : ""}${share.mode === "broadcast" ? " (broadcast)" : ""}${share.keys === "full" ? " (keys full)" : ""}${share.recording ? ` (recording ${share.recording.state}: ${share.recording.bucket}/${share.recording.path})` : ""}  ${share.expiresAt}`)
      } else if (values.revoke) {
        await api.revokeShare(id, values.revoke)
        if (asJson) printJson({ revoked: values.revoke })
      } else {
        // a recording is a broadcast's: --record alone asks for one
        const mode = values.mode === "broadcast" || values.mode === "vnc" ? values.mode : record ? "broadcast" : undefined
        const share = await api.createShare(id, { stream: tty ? "tty" : "screen", ...(tty ? { session: tty } : {}), ...(display ? { display } : {}), ...(values.quality === "low" ? { quality: "low" as const } : {}), ...(mode ? { mode } : {}), ...(values.keys === "full" || values.keys === "masked" ? { keys: values.keys } : {}), ...(record ? { record } : {}), ...(ttlSeconds === undefined ? {} : { ttlSeconds }) })
        if (asJson) printJson(share)
        else console.log(share.url)
      }
      return 0
    }
    case "shell": {
      let [id, extra] = positionals
      if (!id || extra) usage("usage: kyora vms shell <id> [--name NAME] [--view] [-- cmd…], or shell <id> --list | --kill NAME")
      const name = values.name ?? "main"
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) usage("--name takes 1-32 characters of A-Z, a-z, 0-9, _ and -, starting with a letter or digit")
      if (values.list || values.kill !== undefined) {
        if (values.list && values.kill !== undefined) usage("--list and --kill don't go together")
        if (tail !== null || values.view || values.env || values.cwd || values.name || values.clipboard) usage(`--${values.list ? "list" : "kill"} takes nothing else`)
        if (values.list) return listSessions(api, await resolveTarget(api, id), asJson)
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(values.kill!)) usage("--kill takes a session's name")
        return killSession(api, await resolveDestructiveTarget(api, id), values.kill!, asJson)
      }
      if (asJson) usage("shell is interactive; --json goes with --list or --kill")
      if ((values.env || values.cwd) && tail === null) usage("--env and --cwd are for the window a command runs in: put it after --")
      if (tail !== null && tail.length === 0) usage("nothing after --; give the command to run, e.g. kyora vms shell <id> -- claude")
      const env = parseEnv(values.env)
      id = await resolveTarget(api, id)
      const sandbox = await api.get(id)
      return shell(api, id, {
        sandboxName: sandbox.name,
        name,
        control: !values.view,
        ...(tail ? { cmd: tail } : {}),
        ...(values.cwd ? { cwd: remotePath(values.cwd) } : {}),
        ...(env ? { env } : {}),
        clipboard: Boolean(values.clipboard) || process.env.KYORA_VMS_CLIPBOARD === "1",
      })
    }
    case "health":
      return health(api, config, asJson)
    case "images": {
      const [sub, profile, extra] = positionals
      if (sub === "build") {
        if (!profile || extra || (Boolean(values.node) === Boolean(values.all))) usage("usage: kyora vms images build <profile> --node <name> | --all")
        const response = await api.buildImage(profile, values.node)
        const result = await response.json() as { builds: Array<{ machine: string; accepted: boolean; error?: unknown }> }
        if (asJson) await json(result)
        else for (const build of result.builds) await write(process.stdout, `${build.machine}: ${build.accepted ? "build accepted" : JSON.stringify(build.error)}\n`)
        return result.builds.every((build) => build.accepted) ? 0 : FAILED
      }
      if (sub !== undefined) usage("usage: kyora vms images [--json], or images build <profile> --node <name> | --all")
      const response = await api.images()
      const result = await response.json() as { images: Array<{ name: string; regions: Array<{ region: string; available: boolean; building: boolean; unknown: boolean; machines?: Array<{ machine: string; present: boolean | null; version: string | null; hash: string | null; builtAt: string | null; building: boolean }> }> }> }
      if (asJson) await json(result)
      else for (const image of result.images) for (const region of image.regions) {
        await write(process.stdout, `${image.name}  ${region.region}  ${region.available ? "available" : region.building ? "building" : region.unknown ? "unknown" : "missing"}\n`)
        for (const machine of region.machines ?? []) await write(process.stdout, `  ${machine.machine}  ${machine.present ? "present" : machine.present === null ? "unknown" : "missing"}${machine.building ? " (building)" : ""}  ${machine.version ?? ""}  ${machine.hash ?? ""}  ${machine.builtAt ?? ""}\n`)
      }
      return 0
    }
    case "image":
      return imageCommand(api, positionals, { name: values.name, region: values.region }, asJson, usage)
    case "nodes":
      if (positionals.length > 0) usage(`nodes takes no arguments, got ${positionals.join(" ")}`)
      return nodes(api, asJson)
    case "regions": {
      const [sub, id, extra] = positionals
      if (sub !== undefined && (sub !== "default" || !id || extra !== undefined)) usage("usage: kyora vms regions, or kyora vms regions default <id>|global")
      if (id !== undefined && id !== "auto" && !REGION_PATTERN.test(id)) usage("regions default takes a region id, e.g. eu, or global")
      return regions(api, positionals, asJson)
    }
    case "whoami":
      if (positionals.length > 0) usage(`whoami takes no arguments, got ${positionals.join(" ")}`)
      return whoami(api, config, asJson)
    case "org": {
      const [sub, ref, extra] = positionals
      if ((sub === "ls" || sub === "list") && ref === undefined) return orgList(api, config, asJson)
      if (sub === "use" && ref !== undefined && extra === undefined) {
        if (!ORG_PATTERN.test(ref) && !["personal", "-", "me"].includes(ref)) usage("org use takes an org's handle (kyora vms org ls), or personal")
        return orgUse(config, ref, asJson)
      }
      return usage("usage: kyora vms org ls, or kyora vms org use <org>|personal")
    }
    case "login":
    case "logout": {
      if (positionals.length > 0) usage(`${verb} takes no arguments, got ${positionals.join(" ")} (the server goes in --url)`)
      const url = values.url ? checkUrl(values.url, "--url") : config.url
      if (verb === "logout") return logout(url, config, asJson)
      // signing in needs no key, and must not send one that belongs to some other server
      if (values.org !== undefined && !ORG_PATTERN.test(values.org)) usage("--org takes an org's handle, e.g. acme")
      return login(new VmsClient({ ...config, url, key: null, keySource: null }), config, asJson, values.org)
    }
  }
  return usage(`unknown command "${rawVerb}"`)
}

/** the note that follows a failure: where its command's usage is */
export function usageHint(error: unknown): string | null {
  if (error instanceof UsageError || error instanceof ComputerUsage) return "run `kyora vms --help` for usage"
  if (error instanceof SessionUsage) return "run `kyora session --help` for usage"
  if (error instanceof StorageUsage) return "run `kyora vms storage --help` for usage"
  if (error instanceof TokenUsage) return "run `kyora vms tokens --help` for usage"
  return null
}
