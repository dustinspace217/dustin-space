## Status (updated 2026-09-07)
Phase: 2 of 2 (publisher and ingest delivery complete)
Done: MeLe update, PR merge, production deployment, and local main reconciliation
Next: verify a real LIGHT during an imaging session; deliver remaining reviewed page/Descent changes
Blocked: no deployment blocker; live-capture acceptance needs a capture

# Publishing delivery receipt

## SSH authentication follow-up — resolved 2026-09-07

The existing GitHub key and KDE SSH agent were healthy. GitHub accepted the offered public key, and the running desktop agent held its matching identity. The failing command environment lacked `SSH_AUTH_SOCK`; the KDE user session already had `SSH_AUTH_SOCK=/run/user/1000/ssh-agent.socket`. The earlier failed command therefore did not establish that desktop-launched ingest was broken.

The smallest persistent correction was one repository-local setting: `core.sshCommand = ssh -o IdentityAgent=/run/user/1000/ssh-agent.socket`. There was no prior value. This makes Git use the existing agent when the invoking process lacks that environment variable. The SSH remote, keys, global configuration and application code remain unchanged. [Git documents the repository command setting](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresshCommand), and [OpenSSH documents the agent-socket selection](https://man.openbsd.org/ssh_config#IdentityAgent).

Verification completed by 19:42 UTC: plain `git push --dry-run` returned `Everything up-to-date`. The real ingest `runOrThrow` helper then passed `ls-remote` and `push --dry-run` with the agent variable absent and with the KDE value present, without a temporary SSH command override. KDE had no overriding Git SSH environment setting. These probes verified authentication without publishing any ref updates; HEAD and origin/main stayed at the release commit below.

This local setting follows the installed systemd socket's stable runtime path. It depends on the existing desktop agent and its loaded key; if the checkout moves to another machine or the agent path changes, update the setting. Undo is `git config --local --unset core.sshCommand`, restoring the prior absence of a local override. No server restart is needed for this Git configuration change.

## Release evidence

[PR #160](https://github.com/dustinspace217/dustin-space/pull/160) merged at 2026-09-07 14:59:31 UTC as `3e6601a8a5f64f9ce23c15469a7dd212e2605607`. Local `main` and `origin/main` were fast-forwarded to that commit. This receipt closes the pending GitHub stage in [the delivery record](2026-09-07-publishing-delivery.md).

The exact release passed all 236 local Node tests, including a production build, 37 focused publisher/ingest tests, publisher lint, and a commit secret scan. GitHub's PR checks passed the Node suite and browser probes; Cloudflare's PR deployment succeeded. The merged commit's CI and Cloudflare deployment also passed; production deployment ID is `cea22404-0a82-44a1-a790-df2f855862f5`.

The MeLe's single-file update, rollback location, hashes and startup evidence are in the delivery record. A second read at 14:58:14 UTC confirmed the same new process (8092), unchanged installation/config hashes, and a successful heartbeat at 14:57:20.050 UTC. NINA still had no captures. No synthetic R2 upload was performed.

The local ingest server was stopped, so its next launch loads the merged safeguards. To reconcile main, only the eight delivered paths were backed up with a path-limited stash; every incoming file was checked against the local reviewed bytes. The stash named `Publishing safeguards before main fast-forward` is retained as a backup and was not reapplied. All 31 other dirty files retained their exact content and status after the fast-forward.

## Scope and deviations

- Scope: the live publisher and ingest safeguards were delivered separately from the broader review repairs. Page, Descent and dependency-automation edits remain local; the storefront was not changed.
- Transport: GitHub SSH authentication failed during the initial delivery, so that release used the existing authenticated `gh` login over HTTPS with a per-command credential helper. The repository's SSH remote was preserved. The later SSH investigation and repository-local fix are recorded above; that follow-up is resolved.
- Verification: fresh startup and heartbeat checks establish that the patched publisher is running. First actual LIGHT publication, latest-frame replacement and browser/CORS acceptance remain imaging-session work. The failure/retry regression paths passed isolated tests.

No implementation deviation was introduced during delivery. The reviewed seven code/test files were shipped unchanged, plus their delivery documentation.
