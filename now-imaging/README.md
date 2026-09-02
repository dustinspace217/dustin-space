# now-imaging — the "Currently imaging" publisher

A small Node service that runs on the imaging PC beside NINA. When NINA saves a
light frame it publishes that frame, plus a little JSON describing it, to
Cloudflare R2. The dustin.space homepage reads the JSON and shows what the rig is
pointed at right now.

It is a daemon: it starts automatically, sleeps until something happens, and
never exits on its own. Every failure is logged and retried on the next trigger.

**The flow, once per saved sub:**

```
NINA WebSocket IMAGE-SAVE ─┐
                           ├─→ debounce 2 s ─→ check()
heartbeat (every 300 s) ───┘                     │
                                                 ▼
   image-history ─→ newest LIGHT ─→ already published? ─ yes ─→ stop
                                          │ no
                                          ▼
   image/{index} (JPEG) → camera/info (next frame due) → resolve target name
                                          │
                                          ▼
   build status → validate → PUT frame.jpg → PUT status.json → delete old frame
                                          │
                                          ▼
                        save state.json, log one `published` line
```

---

## Install on the imaging PC

1. **Install Node 22 or newer** (`node --version` to confirm). The agent uses
   the built-in `fetch` and `WebSocket`, both of which need 22.
2. **Copy this folder** to the machine, e.g. `C:\now-imaging`.
3. **Install dependencies** from inside that folder:
   ```
   npm ci --omit=dev
   ```
   `--omit=dev` skips ESLint, which is only needed for development.
4. **Create the config**: copy `config.example.json` to `config.json` and fill in
   the three R2 values. `config.json` is gitignored and never leaves the machine.
5. **Check NINA is reachable** — the Advanced API plugin must be enabled and
   listening (default port 1888):
   ```
   node tools\nina-probe.js http://localhost:1888
   ```
   It prints the history count, the newest light frame, and the camera state.
6. **Dry run first** (writes to `.\dry-run\` instead of R2):
   ```
   npm run dry-run
   ```
   Watch for one `published` line, then stop it with Ctrl+C.
7. **Register the Scheduled Task** so it starts at logon and restarts if it dies:
   ```
   schtasks /create /tn "now-imaging" /tr "node C:\now-imaging\agent.js" /sc onlogon /rl limited
   ```
   In Task Scheduler, open the task's properties and tick **"If the task fails,
   restart every 1 minute"** and **"Restart up to 3 times"** on the Settings tab.
   The working directory does not matter: `agent.js` finds `config.json` beside
   itself, and every path in the config resolves against the config's own folder.

---

## Config keys

Every key is optional except the three R2 credentials, and those are only
required when `dryRunDir` is unset. Relative paths resolve against the folder
holding `config.json`.

| Key | Default | What it does |
|---|---|---|
| `ninaBaseUrl` | `http://localhost:1888` | Base URL of NINA's Advanced API. The WebSocket URL is derived from it (`http` → `ws`). |
| `r2AccountId` | *(required)* | Cloudflare account ID, used to build the R2 endpoint. |
| `r2AccessKeyId` | *(required)* | R2 access key with write access to the bucket. |
| `r2SecretAccessKey` | *(required)* | Its secret. |
| `r2Bucket` | `dustinspace-live` | Bucket the frame and `status.json` are written to. |
| `publicBaseUrl` | `https://live.dustin.space` | Public origin for the bucket. The URL in `status.json` is this plus the object key. Must start with `https://` — the publish gate refuses a document whose frame URL is not https, so an `http://` origin here would build a document that can never be published. |
| `imageScale` | `0.2` | Fraction of NINA's prepared image to request, in (0, 1]. Linear, not area: this camera came back 1250 px wide at 0.2 and 2501 px at 0.4. Higher costs bandwidth on every sub and can trip the 3 MB image cap. |
| `jpegQuality` | `80` | JPEG quality, an integer 1–100. |
| `heartbeatSeconds` | `300` | How often to check anyway, in case the socket died quietly. Minimum 30. |
| `dryRunDir` | `null` | When set, write files here instead of to R2, and skip the credential check. `--dry-run` sets it to `./dry-run` if the config has not. |
| `logPath` | `now-imaging.log` | Where the log is written. |
| `statePath` | `state.json` | Remembers the last published frame so a restart does not re-publish it. |
| `resolveCachePath` | `resolve-cache.json` | Cached Simbad answers, so a target is looked up once ever. |

These keys are checked when the config is read: `imageScale`, `jpegQuality`,
`heartbeatSeconds`, `publicBaseUrl`, and the three R2 credentials (those last
only when `dryRunDir` is unset). A bad one throws at startup with the key named,
rather than failing at 2 a.m. The remaining keys are used as given — a wrong
`ninaBaseUrl` or `r2Bucket` shows up as a failing `check`, not as a startup
error.

---

## Running

| Command | What it does |
|---|---|
| `npm start` | Normal run: socket, heartbeat, publishing to R2. Never exits. |
| `npm run dry-run` | Same, but writes to `.\dry-run\` and touches neither R2 nor its credentials. |
| `node agent.js --once` | One check, then exit. Publishes if there is a new frame. Used by the verification pass. |
| `node agent.js --config D:\other\config.json` | Use a config from somewhere else. All its relative paths resolve against that folder. |

Flags combine: `node agent.js --dry-run --once` is the fastest end-to-end check.

---

## Overrides

`overrides.json` forces the two names shown on the card for a given NINA target
name, skipping Simbad entirely:

```json
{
	"M 27": { "name": "Dumbbell Nebula", "designation": "M 27" }
}
```

The key is matched case-insensitively with runs of whitespace collapsed, so
`m 27` and `M  27` both hit. Keys starting with `_` are treated as comments.

Reach for an override when Simbad's answer is right but not what an astronomer
would say out loud. Three cases found while building this:

- **M 27 comes back as "Diabolo Nebula".** Simbad's alias list is not ordered by
  common usage, and "Diabolo Nebula" precedes "Dumbbell Nebula" in it. Hence the
  seeded entry above.
- **IC 1396 has no colloquial alias in Simbad at all.** The card shows
  "IC 1396", which is what most people call it anyway, so no override is needed.
  Add one only if you want "Elephant's Trunk Nebula" on the card.
- **Simbad carries no Caldwell identifiers.** A Caldwell target resolves to its
  NGC or IC number instead. If the Caldwell designation is the one you want, an
  override is the only way to get it.

An override takes effect on the next publish. `overrides.json` is consulted
before `resolve-cache.json`, so an override always beats a cached Simbad answer
and there is no cache to clear after editing one.

Deleting `resolve-cache.json` is safe regardless: it is rebuilt from Simbad on
demand. Do that when you want a name Simbad has since corrected to be looked up
again.

---

## Logs

The log lives at `logPath` (`now-imaging.log` beside the config by default) and
is mirrored to the console. It rotates at 5 MB: the live file becomes
`now-imaging.log.1` and a new one starts. Only one predecessor is kept, so the
pair never exceeds about 10 MB.

Lines are `<ISO timestamp> <LEVEL> <message>`. A healthy night looks like this —
one banner, one socket line, then one `published` line per saved sub:

```
2026-09-01T02:58:11.004Z INFO agent started (nina=http://localhost:1888, bucket dustinspace-live)
2026-09-01T02:58:11.180Z INFO socket open, subscribed to IMAGE-SAVE
2026-09-01T03:04:52.771Z INFO published now/sub-20260901T030431Z.jpg target="Veil Nebula" -> "Veil Nebula / NGC 6960" filter=Ha exp=300s subsTonight=1 dims=1250x835 bytes=214933
2026-09-01T03:10:03.412Z INFO published now/sub-20260901T030942Z.jpg target="Veil Nebula" -> "Veil Nebula / NGC 6960" filter=Ha exp=300s subsTonight=2 dims=1250x835 bytes=215774
```

Then, when NINA shuts down at the end of the night:

```
2026-09-01T11:22:40.918Z INFO socket closed; reconnecting in 1043 ms
2026-09-01T11:22:42.001Z WARN socket error (no reconnect from this event; the heartbeat covers it)
```

Reconnection is driven by the socket's *close* event. Losing an established
socket produces one, so the agent schedules a retry; that retry then hits a port
with nothing listening, which (measured on Node 22, 2026-09-01) reports only
`error` and never closes. So the socket does not keep retrying through the day —
after NINA exits, the log goes quiet and the **heartbeat** is what keeps the card
current, at up to `heartbeatSeconds` of lag.

Each reconnect gap that does occur doubles, up to one minute, and a socket that
drops again within a minute of opening does not reset that backoff.

---

## Troubleshooting

**No `socket open` line, but frames still appear.** The WebSocket did not
connect, and the heartbeat is doing the work. Publishing is up to
`heartbeatSeconds` late but otherwise correct. Check that the Advanced API's
WebSocket is enabled. Note that a socket which never opened does not retry on
its own (see Logs, above): once NINA is back, restart the agent to get the
sub-second path back.

**`check failing repeatedly (n=…)`.** Five or more consecutive failures. The
`check failed:` line above it names the endpoint and the reason. Usual causes:
NINA is not running (`connect ECONNREFUSED`), the port in `ninaBaseUrl` is
wrong, or the Advanced API is configured to require a key — this client sends
none, and that shows up as `HTTP 401`. The agent keeps retrying; nothing needs
restarting once NINA is back.

**`status rejected: forbidden key "…"`.** The privacy gate refused the document
because a key looked like it carried the observing site's location. Nothing was
published. This should be impossible with the current fields, so it means an
edit added something it should not have; the message names the offending path.

**`status rejected after publish: …` or `published URL mismatch: …`.** A
tripwire, not the gate above. The document is validated in full BEFORE the
upload, so reaching this means the document changed between that check and the
upload finishing — in practice, that `keyForFrame` in `lib/publish.js` and the
URL the agent built from `publicBaseUrl` stopped agreeing. Both uploads have
already happened, so a wrong URL is briefly public and `state.json` was not
saved, which makes the next heartbeat retry the same frame. Not
self-correcting: report it, and check the two key derivations against each
other.

**`queued orphaned frame … for deletion`.** The JPEG uploaded but `status.json`
did not, so the frame is in the bucket with nothing pointing at it. It is queued
and the next successful publish deletes it. No action needed.

**`published` lines say `(unresolved)`.** Simbad did not answer for that target
name — an outage, or a name it does not carry. The card still works; it shows
the raw name with no catalog designation. If it persists for a target you care
about, add an override.

**Nothing at all in the log.** The process is not running. Check the Scheduled
Task's Last Run Result, and run `node agent.js --once` by hand: a bad config
fails immediately with the offending key named.

---

## Privacy

The agent reads exactly four NINA surfaces and nothing else:

| Endpoint | Why |
|---|---|
| `/v2/api/image-history?all=true` | Which frames exist, their target, filter, exposure and timestamps. |
| `/v2/api/image/{index}` | The JPEG of one frame. |
| `/v2/api/equipment/camera/info` | Whether an exposure is running, and when it ends. |
| `/v2/socket` | The IMAGE-SAVE event. |

NINA's profile endpoint is deliberately never called. It carries the observing
site's latitude, longitude and elevation, and none of that is wanted here.

The published document is built field by field from a fixed list rather than by
copying NINA's row, so nothing reaches it that the code does not name. On top of
that, `validateStatus` refuses to publish any document containing a key that
looks locational (`lat`, `lon`, `site`, `elev`, `observer`) at any depth — before
the upload, so a rejected document never becomes public. The published JSON
carries the target, the frame's technical details, the camera and telescope
names, and the image URL. It carries no coordinates, no file paths, and no
identity.
