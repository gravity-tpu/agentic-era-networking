# Jetson backup (restic over rclone to Google Drive)

Daily encrypted, deduplicated backup of everything on the Jetson that exists nowhere else: the OVS testbed
configuration, `/etc/zodiac`, `/var/lib/zodiac` (including conformance captures), the O3 capture-NIC files, and
the host hardening that took effort to get right. Mac-side single-copy files are covered by
[`scripts/backup-mac-local.sh`](../../../scripts/backup-mac-local.sh).

## Status

- Tested: the full round trip (init, run, second snapshot, content checks, secrets excluded, restore drill,
  the drill passes after a legitimate edit and fails on a restore that does not match the repository) against a local restic repository on the Mac with a fake root
  (`./test-backup-local.sh`).
- **Not tested on the Jetson, and not tested against Google Drive.** First real run is the test. Do the restore
  drill (step 6) before trusting it.
- Google Drive has no append-only mode. Anyone holding the rclone token can delete or overwrite the repository.
  This protects against disk loss and mistakes, not against a compromised Jetson.

## What is and is not backed up

Backed up: see `CANDIDATES` in `zodiac-backup.sh` (`zodiac-backup.sh paths` prints what exists on this host and
what was skipped). Each run also stores a text inventory (packages, units, routes, USB tree, OVS
`show`/flows/ports, an `ovsdb-client backup` copy of the OVS database).

Never backed up, by design: `/etc/zodiac/restic-password` and `/etc/zodiac/rclone.conf`. Keep a copy of the
restic password in your password manager. **Without it the backup is unrecoverable.**

## Setup

1. Copy this directory to the Jetson and run `sudo ./install.sh`. It installs restic and rclone, the scripts and
   units, and a default `/etc/zodiac/backup.env`; it does not create secrets or enable the timer.
2. Authorize Google Drive from the Mac (the Jetson has no browser). Use the `drive.file` scope, which limits
   rclone to files it creates:
   `rclone authorize "drive" --drive-scope drive.file`, then paste the token into a remote named `gdrive`
   in `/etc/zodiac/rclone.conf` on the Jetson (`chmod 600`, owner root).
3. Create the password: `openssl rand -base64 33 | sudo tee /etc/zodiac/restic-password`, `chmod 600`, and store
   a copy in your password manager now.
4. Adjust `/etc/zodiac/backup.env` if needed (repository, retention).
5. `sudo zodiac-backup.sh init`, then `sudo zodiac-backup.sh run`, then `sudo zodiac-backup-restore-drill.sh`.
   Proceed only when the drill prints PASS.
6. `sudo ./install.sh --enable-timer` (refuses if the password file is missing). Runs daily at 03:15;
   `zodiac-backup-failed.service` fires on failure. Status is in `/var/lib/zodiac/backup-status.json`.

## Retention

7 daily, 4 weekly, 6 monthly (`KEEP_*` in `backup.env`). `forget --prune` runs weekly.

## Recovery

1. On a fresh Jetson install restic and rclone, recreate `rclone.conf` and `restic-password` from your
   password manager.
2. `restic snapshots` then `restic restore latest --target /tmp/restore`.
3. Copy files back selectively (`/etc/zodiac`, `/etc/openvswitch`, units, udev rules). The inventory in the
   snapshot (`packages-manual.txt`, `unit-files.txt`) lists what to reinstall.
4. `ovsdb-client` backup copy (`ovs-conf.db.backup`) can replace `/etc/openvswitch/conf.db` with OVS stopped.

## Known limits

- Backs up files, not a bootable image. A dead disk means reinstall plus restore.
- The inventory commands are best effort; a missing tool is recorded as `(not installed: ...)`.
- restic exit code 3 (some files unreadable) is tolerated and recorded as a warning in the status file. Retention
  (`forget`/`prune`) is skipped on such a run so a degraded snapshot cannot push complete ones out.
- `EXTRA_PATHS` is split on whitespace: no spaces inside a path.
- The drill's 5% integrity check can cover few or no packs on a very small repository.
