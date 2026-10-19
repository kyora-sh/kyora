# kyora switch

Hot-swap Claude Code, Codex, OpenCode, Muse, Grok Build and Antigravity logins. Save the account you are logged into as a named slot, then load it back later: no logging out, no re-auth, no browser round trip.

```bash
claude                        # /login as account 1
kyora-switch claude save work

claude                        # /login as account 2
kyora-switch claude save private

kyora-switch claude load work        # back to account 1
kyora-switch claude load private     # and back again
```

Codex works the same way, with its own slots:

```bash
codex login
kyora-switch codex save work
kyora-switch codex load private
```

So does OpenCode, for its subscription logins: OpenCode Go and its pay-as-you-go sibling Zen:

```bash
opencode auth login           # pick OpenCode Go, paste the key
kyora-switch opencode save work
kyora-switch opencode load private
```

Only the Go and Zen entries move. Everything else opencode is logged into: OpenAI, Z.AI, xAI: stays exactly as it is.

Muse works the same way again:

```bash
muse login
kyora-switch muse save work
kyora-switch muse load private
```

One exception: `META_API_KEY` always beats the account login in Muse, so while it is set, Muse runs on that key whatever slot is loaded. `save`, `load`, `clear`, `status` and `doctor` say so when it is set; unset it to use slots. `kyora-switch muse usage` reads each slot's five-hour and weekly windows from dev.meta.ai for the login's team. A login in several teams needs its team set once per slot, `kyora-switch muse team work <teamId>` (the id dev.meta.ai shows in `?team_id=`; `unset` clears it), which is kept in the slot's `slot.json`, never in Muse's own files. Where dev.meta.ai does not take the CLI login, or the slot is an API key, usage reads a [web session](#web-sessions) instead, or says to log one in. When `auth.json` and the macOS keychain hold different Muse logins, or the keychain holds one kyora-switch cannot read, kyora-switch follows the keychain, as Muse does on macOS, and `save`, `load`, `clear` and `status` say so.

And Grok Build (`grok`):

```bash
grok login
kyora-switch grok save work
kyora-switch grok load private
```

The account login in `auth.json` beats `XAI_API_KEY` (and the older `GROK_CODE_XAI_API_KEY`) in grok, so a loaded slot wins over an exported key; only `GROK_AUTH`, an inline login, beats every slot, and `save`, `load`, `clear`, `status` and `doctor` say so while it is set.

And Antigravity (`agy`), on macOS, where it keeps its login in the keychain:

```bash
agy                           # sign in
kyora-switch agy save work
kyora-switch agy load private
```

Antigravity's terms rule out automated account rotation on consumer plans, so agy slots move only when you run `load` yourself: kyora-switch never switches them on its own. `AGY_LLM_GATEWAY_API_KEY`, `AGY_ADC_AUTH` or `GOOGLE_CLOUD_PROJECT` can make agy sign in some other way, and `save`, `load`, `clear` and `status` say so while one is set.

## Install

Requires [Bun](https://bun.sh) on your PATH. `npx` is not supported.

```bash
bun add -g kyora-switch
kyora-switch status
```

Or run it without installing anything:

```bash
bunx kyora-switch status
```

The `kyora` CLI from `@kyora-sh/vms` runs it too: `kyora switch …` takes the same commands and flags.

Supports macOS and Linux. Windows is untested.

On macOS, Claude credentials are read from the keychain first, falling back to the file when the keychain item is absent. Loading a slot verifies the keychain write and updates the credentials file too.

To run from a checkout, add a symlink on your PATH:

```bash
ln -s "$PWD/packages/switch/cli/src/index.ts" ~/.local/bin/kyora-switch
```

Or run `bun packages/switch/cli/src/index.ts` directly.

## Commands

Every provider takes the same verbs, under `kyora-switch claude …`, `kyora-switch codex …`, `kyora-switch opencode …`, `kyora-switch muse …`, `kyora-switch grok …` or `kyora-switch agy …`:

| command | what it does |
| --- | --- |
| `save <slot>` | store the account that provider is logged into right now |
| `load <slot>` | log that provider back into a stored account |
| `list` | slots for that provider, with the live one marked |
| `usage` | how much quota each stored account has left |
| `tokens` | token totals for each stored account ([below](#token-totals)) |
| `sync` | copy the live login back into its slot |
| `clear` | sign out locally, without revoking the account |
| `rm <slot>` | delete a slot |
| `rename <old> <new>` | rename a slot |
| `web-login <slot>`, `web-logout <slot>` | keep or forget a browser session for the slot ([below](#web-sessions)); Muse only so far |

A few commands span every provider:

| command | what it does |
| --- | --- |
| `status` | which account each CLI is logged into, which slot it came from, and its data collection |
| `usage` | remaining quota across every stored account, every provider |
| `tokens` | token totals across every stored account, every provider |
| `doctor` | where each CLI keeps its auth on this machine, and what it reads back |

Under each login, `status` names what that CLI's data collection is set to, read only from local settings and the environment: telemetry, and whether the account's data may train models where that is kept locally (Grok Build keeps it per account, so `grok list` shows it per slot). A setting kept only on the vendor's side says so. `status --json` has it as `dataCollection`.

If one provider's login cannot be read, `status`, `usage`, `refresh` and `sync` show an `unreadable` row for that provider, still show every other provider, and exit with code 1. With `--json`, that provider's entry is an `error` object instead.

Options: `--json` for `list`, `status`, `usage` and `tokens`, `--no-renew` for `usage` (ignored), `--local` and `--detailed` for `tokens`, `-y` to skip the `rm` confirmation, `--force` to `load` or `save` a slot kyora cloud owns ([below](#slots-kyora-cloud-owns)) or to `load` agy while it runs.

Slots are namespaced per provider, so `claude/work`, `codex/work`, `opencode/work`, `muse/work`, `grok/work` and `agy/work` are independent: you can save one without touching the others.

## Which account has room left

`usage` shows remaining quota for each saved account:

```
$ kyora-switch usage
claude: Claude Code
* work     you@work.dev · Acme · max
           38% left   session 50% used, resets in 3h 33m · weekly 32% used, resets in 4d · weekly Fable 62% used, resets in 4d
  private  you@home.dev · max
           9% left    session 91% used, resets in 38m · weekly 44% used, resets in 3d

codex: Codex
* work     you@work.dev · pro
           26% left   7d 74% used, resets in 6d · GPT-5.3-Codex-Spark 5h 0% used, resets in 5h

opencode: OpenCode
* work     key …a1b2 · Go
           37% left   5h 12% used, resets in 3h · weekly 41% used, resets in 4d · monthly 63% used, resets in 16d
```

`*` marks the current local login. Remaining quota uses the tightest window, including model-specific limits.

| provider | source |
| --- | --- |
| Claude Code | `api.anthropic.com/api/oauth/usage`, the endpoint `/usage` reads |
| Codex | `chatgpt.com/backend-api/wham/usage`, the endpoint `/status` reads |
| OpenCode Go | `opencode.ai/zen/go/v1/usage`, authenticated with the Go key itself |
| Muse | `dev.meta.ai/api/portal/teams/<team>/subscription-quota`, the endpoint its usage page reads: the five-hour and weekly windows and the tier, for the team `muse team` set, else the login's only team |
| Grok Build | `cli-chat-proxy.grok.com/v1/billing?format=credits`, the endpoint `/usage` reads: the share of included credits used this period |
| Antigravity | `daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` (the host agy itself calls) for the login's project and tier, then `retrieveUserQuotaSummary` (the buckets agy's `/usage` shows), else `retrieveUserQuota` |

Claude and Codex usage includes plan and model-specific limits.

`usage` only reads: it never renews a login, the live one included, and calls no token server. Quota is read live on every run, never cached. An expired login shows as expired, with a hint to run `refresh`:

```bash
kyora-switch refresh           # renew the live logins and stale slots, then show usage
kyora-switch claude refresh    # the same for one CLI
kyora-switch usage --refresh   # same as refresh
```

Refresh updates saved logins for accounts that are not in use locally, and renews the live Claude Code, Grok Build or Antigravity login once its access token runs out (or is inside the margin the CLI renews it at), but only while that CLI is not running: a running CLI renews its own login, and when kyora-switch cannot tell whether it runs, it leaves the login alone. A login whose renewal failed is left alone for an hour, unless you run `refresh` for that CLI alone; one whose refresh token was refused stays refused until you save it again. `--no-renew` is accepted and changes nothing. Expired or revoked logins require signing in again. An Antigravity login is renewed for the OAuth client its ID token names; where Google wants that client's secret and none is set in `KYORA_AGY_OAUTH_CLIENT_SECRET`, refresh has agy renew the live login itself by running `agy models`, which sends no prompt; a saved slot that is not live then needs agy run with it loaded. Codex slots generally last around ten days. OpenCode Go keys do not expire; Zen has no quota windows.

## Web sessions

Some usage pages take only a browser session, not the CLI's login. For those, a slot can keep one:

```bash
kyora-switch muse web-login work    # log in by hand in a throwaway browser window
kyora-switch muse usage             # reads work's windows with that session
kyora-switch muse web-logout work   # forget it
```

`web-login` opens Google Chrome or Chromium (else Playwright's Chromium, else Edge or Brave; `KYORA_SWITCH_BROWSER` picks one) on a fresh, temporary profile, never your own. You log in there yourself; kyora-switch never types into the page. Once the site answers as logged in, it reads that site's cookies over the DevTools protocol (on a pipe to the browser, never a network port), keeps only the ones the site's own requests carry, closes the browser and deletes the profile. Profiles left behind by a web-login that was killed are deleted by the next one. Firefox cannot hand the session back, so it is not used.

The cookies are kept per slot: in the macOS keychain (`kyora-switch.<provider>-web.<slot>`), elsewhere, or when it is too long for the keychain, in `~/.kyora/switch/web-sessions/<provider>/<slot>.json` (`0600`). They are never printed, never passed on a command line, and never written into the provider's own files or the slot directory, so `save`, `sync` and `kyora session creds sync` never touch them. `rename` moves a slot's session, `rm` deletes it, and saving another account over the slot drops it. A session lasts as long as the site keeps it; once it lapses, usage says `web session expired` and names the `web-login` to run.

Usage tries the slot's account login first and the web session only when the site refuses it, or when the slot is an API key.

## Token totals

`tokens` shows the overall total, then one line per tool with its input, output, cache read and cache write. `--detailed` adds the split by saved slot:

```bash
kyora-switch tokens
kyora-switch claude tokens
kyora-switch tokens --detailed
kyora-switch tokens --json
kyora-switch tokens --local     # count only records on this machine, including Codex
```

| provider | source |
| --- | --- |
| Claude Code | Assistant message usage in `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl` (default `~/.claude`) |
| Codex | `GET https://chatgpt.com/backend-api/wham/profiles/me`, `stats.lifetime_tokens`, using each slot's bearer token and ChatGPT account ID |
| Codex with `--local` | `$CODEX_HOME/sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl` (default `~/.codex`), completion usage records or older cumulative token counters |
| OpenCode Go and Zen | `$XDG_DATA_HOME/opencode/opencode.db` (`session_message` under `session_v2`, and V1 `message` rows of sessions not migrated yet), or legacy `storage/message/**/*.json` when the database is absent (default `~/.local/share`) |
| Muse | `$XDG_DATA_HOME/muse/sessions/**/session.jsonl` (default `~/.local/share/muse/sessions`), `model_completed` usage records |
| Antigravity | `~/.gemini/antigravity-cli/conversations/<id>.db` (under `$ANTIGRAVITY_GEMINI_DIR` when set), each model reply's usage in its step metadata; a fork's copied replies count once. agy's side calls (safety monitors) are not recorded there |
| Grok Build | `$GROK_HOME/sessions/**/usage.json` (default `~/.grok/sessions`), one record per turn; a fork's copied turns count once and subagent sessions count through their parent |

Local rows are labelled **counted on this machine**. They cover retained logs, including subagents, across projects. OpenCode messages for other providers are excluded. Input excludes cache reads and writes; output includes reasoning where reported. Codex's account endpoint supplies only a total, so its rows show just that (the parts are `null` in JSON). Slots of the same login count once: the same ChatGPT account and user, by the ids in the slot's tokens, whatever emails they show. Two users of one workspace count apart. Slots whose tokens name no user can't be told apart within their workspace, so they count once and the total is partial. Unavailable accounts stay unknown, say why (no ChatGPT login in the slot, an expired stored token, or no answer), and the combined result is labelled partial. The overall figure combines the stated coverage of each provider; it is not a complete lifetime bill across machines. `--local` makes all three use local coverage.

Local usage is assigned to the slot active when each message was recorded. Earlier records, removed slots and signed-out periods appear as **unattributed**. Manual logins, overlapping CLI processes and sessions still using an old login can make attribution inaccurate. OpenCode Go and Zen usage is assigned only when the saved slot still holds the subscription key used at the time.

Claude Code logs a reply once per content block, each line with the whole reply's usage; `tokens` counts the reply once. Claude Code's own `/stats` (`stats-cache.json`) counts every line and keeps the days whose logs it deleted (`cleanupPeriodDays`), so it reads higher. `tokens` shows that figure under Claude's line, with the day its oldest retained log starts.

Older Codex logs may include estimates. Incomplete session or fork history, unreadable files, malformed records and records over 16 MB make totals **partial**. Running sessions are counted as they stand when read; run `kyora-switch tokens` again for updated totals. Use `kyora-switch tokens --json` to inspect coverage and partial results. Delete `token-cache-v1.sqlite` under `KYORA_SWITCH_DIR` to force a recount.

Use `kyora-switch tokens --private` to hide account emails. Cloud-owned slots are read without syncing or refreshing their credentials.

## Slots never fall behind the CLI

`status`, `list`, `usage` and `load` update the slot for the current local login. `sync` does this explicitly. If several slots match the account, run `save <slot>` to select one. Updates that replace a different login are backed up under `sync-backups/`. Other accounts' slots are unchanged.

## Slots kyora cloud owns

`kyora session creds sync` uploads logins to kyora cloud. `kyora session creds return --slot <name>` returns a login to local use.

While a slot is in use by kyora cloud:

- Local sync and refresh skip it.
- `load` and `save` require `--force`, which may sign out a cloud or local session. `rename` requires returning the slot first.
- `rm` deletes only the local slot. Use `kyora session creds rm --slot <name>` to delete the cloud copy.
- `list` and `usage` show `(kyora cloud)`; JSON includes `cloudOwned`.

## Signing out without losing the account

`codex logout` and Claude's `/logout` invalidate the saved login. Use `clear` to sign out locally while keeping saved slots usable.

```bash
kyora-switch codex clear     # remove the local credentials, nothing else
codex login                  # now log in as someone else
```

`clear` removes only what is on this machine: `~/.codex/auth.json` for Codex, for Claude Code the OAuth blob plus the `oauthAccount` key, for OpenCode the `opencode-go` and `opencode` entries of its `auth.json`, leaving every other provider in that file logged in, and for Muse only the `providers.meta` entry of its `auth.json`, leaving its other keys and providers in place, plus its keychain item, and for Grok Build the login under the scope grok signs in with (the stored API key when it has no session), as `grok logout` does, leaving every other scope in place, and for Antigravity its keychain item. Saved slots remain usable. The outgoing login is backed up.

`config.toml`, project history, settings and MCP config are untouched.

## What actually gets swapped

Only the credentials and the account they belong to. Session history, project settings, and MCP config stay where they are.

**Claude Code**

- the OAuth blob, from the macOS login keychain (service `Claude Code-credentials`) or `~/.claude/.credentials.json` where there is no keychain
- `oauthAccount` in `~/.claude.json`, and nothing else in that file: `userID` and `machineID` identify the install, not the account, so they stay put

Project history, settings, marketplace configuration and entitlement caches stay unchanged.

**Codex**

- `~/.codex/auth.json`. `config.toml` is configuration, not auth, so it stays.

**OpenCode**

- the `opencode-go` (Go) and `opencode` (Zen) entries of `~/.local/share/opencode/auth.json`, or `$XDG_DATA_HOME/opencode/auth.json`. That one file holds every provider opencode is logged into, so a slot stores only those two entries and a load merges them back in, leaving OpenAI, Z.AI, xAI and the rest where they were.

OpenCode logins are shown as `key …a1b2 #3f9c0e1d` with their plan. `load` replaces the saved Go and Zen entries; separate logins for other providers stay unchanged. Outgoing credentials are backed up.

**Muse**

- the `providers.meta` entry of `auth.json` in the muse config dir (`$XDG_CONFIG_HOME/muse`, else `~/.config/muse`), plus the macOS keychain item (`ai.meta.dev.credentials`, account `meta`) as its own slot file where there is one: the two are backends for the same credential and are not assumed to hold the same bytes. A load merges the saved entry back, leaving every other key and provider in `auth.json` in place. `settings.json` and `trust.json` stay untouched.

Muse logins are shown by account email (or full name, which is never used to match a login to a slot) with their subscription tier, or "api key" for a key stored with `muse auth set`. Muse renews its own login when a slot is loaded, so slots are never refreshed from here, and a slot whose stored access token has expired shows no usage until it is loaded and muse renews it: see the usage table above. While `META_API_KEY` is set it wins over every slot, and `save`, `load`, `clear`, `status` and `doctor` all say so.

**Grok Build**

- `auth.json` in the grok home (`$GROK_HOME`, else `~/.grok`), or the file `GROK_AUTH_PATH` names. A slot holds only the login grok signs in with and the key `grok login --api-key` stored; `load` puts those two back and keeps every other scope, such as an enterprise OIDC login. A slot saved under another sign-in scope than the one grok now uses is refused. Writes go through a symlinked `auth.json` and hold grok's own `auth.json.lock`. Its config, sessions and caches stay untouched.

Grok Build logins are shown by account email with their team, or as `key …a1b2 #3f9c0e1d` for a key stored with `grok login --api-key`. A team login carries no email, so it is matched to its slot by its user and team ids. A stale stored xAI session is renewed with its refresh token, the same call grok makes, and written straight back to the slot, since xAI refresh tokens are single use.

**Antigravity**

- the macOS keychain item agy keeps its login in (service `gemini`, account `antigravity`), stored as it is. Its settings, conversations and `~/.gemini` files stay untouched; `~/.gemini/oauth_creds.json` belongs to Gemini CLI, not agy.

Antigravity logins are shown by the email in their ID token. agy renews its own token while it runs and writes it back to the keychain, so `load` refuses while agy runs (`--force` loads anyway; restart agy after). When agy has left a `keyring-marker-*` file, it may be keeping its login in a file instead of the keychain; `status` and `doctor` say so.

## How hot is "hot"

Restart `claude`, `codex`, `opencode`, `muse`, `grok` or `agy` after loading a slot. `load` warns when one is running.

## Safety

- every `load` copies the outgoing login to `~/.kyora/switch/backups/<provider>/<timestamp>/` first, so a switch made before you saved the current account is still recoverable: the last 10 per provider are kept
- `load` warns when the login it just replaced was in no slot
- slots and backups are written `0600` under `0700` directories, and restoring a credentials file tightens its mode to `0600` even if it was laxer
- files are replaced atomically, so a running CLI never reads a half-written config

Slots are plaintext credentials on disk, exactly like the files they came from. They are as sensitive as the logins themselves: do not sync `~/.kyora/switch` anywhere.

## Environment

| variable | effect |
| --- | --- |
| `KYORA_SWITCH_DIR` | where slots and backups live (default `~/.kyora/switch`) |
| `KYORA_SWITCH_NO_KEYCHAIN=1` | keep Claude credentials in files only, never the keychain |
| `KYORA_SWITCH_BROWSER` | the Chromium-family browser `web-login` opens |
| `KYORA_SWITCH_DEBUG=1` | say on stderr why a line of the switch history was not written |
| `CLAUDE_CONFIG_DIR` | respected, same as Claude Code reads it |
| `CODEX_HOME` | respected, same as Codex reads it |
| `XDG_DATA_HOME` | respected, same as opencode reads it |
| `OPENCODE_AUTH_CONTENT` | opencode reads its logins from this instead of `auth.json` when set; `doctor` warns, since a load cannot reach it |
| `XDG_CONFIG_HOME` | respected for Muse's config dir, same as muse reads it |
| `META_API_KEY` | beats every Muse slot while set; `save`, `load`, `clear`, `status` and `doctor` report it, and its value is never stored |
| `GROK_HOME`, `GROK_AUTH_PATH` | respected, same as grok reads them |
| `GROK_AUTH` | an inline grok login that beats every slot while set; reported like `META_API_KEY`, never stored |
| `XAI_API_KEY`, `GROK_CODE_XAI_API_KEY` | used by grok only when no account login is loaded; reported when the live login is a stored key alone |

## Development

```bash
bun test
bun run check-types
```

Tests never touch the real keychain or your real logins: they run against temp directories, and a preload (`src/test-setup.ts`) disables keychain access and points `HOME` and every login location at an empty sandbox before any test starts.

`bun test` also checks that every existing command still prints what the merge base with `origin/main` prints, byte for byte, and leaves the same files behind (bytes and permissions; the new history files, the token cache and timestamps aside), on the same fixture slots, through saves, loads and every provider's clear. It runs whenever `origin/main` is there. CI requires it (`KYORA_SWITCH_DIFF_REQUIRED=1`). Another base:

```bash
KYORA_SWITCH_DIFF_BASE=origin/main bun test src/differential.test.ts
```

## License

Apache-2.0, see LICENSE.
