# @kyora-sh/usage

Engine quota state and live usage probing, shared by [kyora review](https://www.npmjs.com/package/@kyora-sh/review), [kyora council](https://www.npmjs.com/package/@kyora-sh/council) and [kyora switch](https://www.npmjs.com/package/kyora-switch).

Modules:

**`state`**: per-engine run history in `~/.local/state/kyora-review/usage.json` or `KYORA_REVIEW_STATE_DIR`. `looksRateLimited` detects rate-limit errors; `resetHintMs` reads reset times.

**`quota`**: current usage as `LiveUsage`, with remaining percentage, detail, and Claude usage windows and reset times.

| function | source |
| --- | --- |
| `claudeOauthUsage(token)` | `api.anthropic.com/api/oauth/usage`: session, weekly, and per-model weekly windows |
| `codexUsage(token, account)` | `chatgpt.com/backend-api/wham/usage`: plan window plus model-scoped limits |
| `codexLifetimeTokens(token, account)` | `chatgpt.com/backend-api/wham/profiles/me`: the account's lifetime token total (`stats.lifetime_tokens`), or null |
| `opencodeGoUsage(key)` | `opencode.ai/zen/go/v1/usage`: OpenCode Go's five-hour, weekly and monthly windows |
| `museUsage(auth, teamId)`, `museTeams(auth)` | `dev.meta.ai/api/portal/teams/<team>/subscription-quota`: Muse Code's five-hour and weekly windows and tier; `/api/portal/teams` lists the login's teams; `auth` is an access token or `{ headers }` of a browser session; a 401 or 403 is `MUSE_UNAUTHORIZED` |
| `parseZaiQuota` | Z.ai monitor, per-window percentages |
| `parseQuotaWindows` | Kimi and anything else exposing used/limit pairs |
| `parseTokenPlanUsage` | Bailian token-plan console credits |

Claude usage includes session, weekly and per-model weekly windows.

`claudeAccessToken(blob)`, `codexCredentials(blob)` and `opencodeKey(authText, "opencode-go" | "opencode")` read credentials from saved logins. `opencodeAuthPath()` returns `$XDG_DATA_HOME/opencode/auth.json` or `~/.local/share/opencode/auth.json`.

OpenCode Go's limits are dollar amounts, but the route reports each window as a floored percentage, and a `rate-limited` window counts as fully spent. Zen, its pay-as-you-go sibling, has no windows and no usage route.

The tightest window always wins: `remainingPct` is what is left on the most constrained limit, not an average.

```bash
bun test
```
