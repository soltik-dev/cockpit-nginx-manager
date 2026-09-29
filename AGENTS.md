# Cockpit Nginx Manager — notes for AI agents and new contributors

Cockpit module (React + PatternFly 6 + TypeScript, bundled with esbuild) that manages
nginx virtual hosts and TLS certificates. Derived from the official
[Cockpit starter kit](https://github.com/cockpit-project/starter-kit); keep its structure.
Repository: `soltik-dev/cockpit-nginx-manager`. AppStream id: `es.soltik.nginx_manager`
(`APPSTREAM_PREFIX` in the Makefile). License: LGPL-2.1-or-later. Target: Fedora/RHEL
servers with Cockpit; nothing should be Fedora-only without a fallback.

## Layout

| Path | Role |
| --- | --- |
| `src/app.tsx` | Page root: loads data, watches directories, renders the four cards |
| `src/components/ServiceCard.tsx` | nginx service status/actions (systemd proxy from `pkg/lib/service.js`) |
| `src/components/SitesCard.tsx`, `SiteDialog.tsx`, `RawEditDialog.tsx`, `LogsDialog.tsx` | Sites list, form, text editor, log viewer |
| `src/components/CertsCard.tsx`, `LetsEncryptDialog.tsx`, `SelfSignedDialog.tsx` | Certificates |
| `src/components/ConfirmDialog.tsx`, `OutputDialog.tsx` | Generic confirm / command-output dialogs |
| `src/components/PoolsCard.tsx`, `PoolDialog.tsx` | PHP-FPM pools list (with php-fpm service status) and form |
| `src/lib/pools.ts` | `PoolConfig` schema and the php-fpm pool ini generator (`renderPool`) |
| `src/lib/php.ts` | PHP-FPM system access: detection, pool listing, save/enable/delete with `php-fpm -t` and rollback |
| `src/lib/templates.ts` | `SiteConfig` schema, validation regexes and the nginx config generator (`renderSite`) |
| `src/lib/nginx.ts` | All system access: spawn/file wrappers, save/enable/delete with rollback, certbot, htpasswd |
| `src/nginx-manager.py` | Helper bundled as text and run with `python3 -c`; prints JSON. Listing, self-signed certs, htpasswd, mkdir, php-fpm detection/pools/users |
| `test/check-application` | Cockpit browser integration tests (need Cockpit's VM test infra: `make check`) |

Shared Cockpit code lives in `pkg/lib/` (not committed; `make` fetches it at
`COCKPIT_REPO_COMMIT` from the Makefile). Import it by bare name: `cockpit`,
`dialogs.jsx`, `hooks`, `superuser`, `service`, `timeformat`, `cockpit-components-*.jsx`.

## Design rules

- **No daemon, no extra service.** Everything runs through `cockpit.spawn()` /
  `cockpit.file()` with `superuser: "require"` for writes and `"try"` for reads.
- **One file per site** in `/etc/nginx/conf.d/<name>.conf`. Managed sites carry their
  settings as JSON in a header line `# nginx-manager: {...}` (`HEADER_PREFIX`). The file
  is regenerated from that JSON on every save. Disabled sites are renamed to
  `<name>.conf.disabled`. Files without the header are "unmanaged": text edit,
  enable/disable, delete only.
- **Never leave nginx broken.** Every write goes through `saveContent()` in
  `src/lib/nginx.ts`: write → `nginx -t` → `systemctl reload` if active; on failure the
  previous content is restored (or the new file removed) and the error is thrown to the
  dialog. Keep that invariant for any new operation.
- **`SiteConfig` is versioned** (`version: 1`). Add fields as optional and write them
  only when they differ from the default (see `validate()` in `SiteDialog.tsx`), so
  headers written by older versions stay valid. Bump `version` only for incompatible
  changes and add a migration.
- **Generated config must work on nginx ≥ 1.22.** `parseVersion()` switches between
  `http2 on;` and `listen ... http2` (1.25.1+). Test templates with
  `nginx -t -p /etc/nginx/ -c <tmp main config>` (see "Testing").
- **Paths (do not change casually, other servers depend on them):**
  Let's Encrypt `/etc/letsencrypt/live/<name>/`, self-signed
  `/etc/nginx-manager/certs/<name>/{fullchain,privkey}.pem` (same layout on purpose),
  htpasswd `/etc/nginx-manager/htpasswd/<site>`, ACME webroot
  `/var/lib/nginx-manager/acme`, logs `/var/log/nginx/<site>.{access,error}.log`.
- **ACME location** is only emitted when the HTTP port is 80 and stays reachable
  despite `allow/deny` and basic auth (`allow all; auth_basic off;`).
- **`add_header` inheritance:** nginx drops server-level `add_header` in any location
  that has its own. The static-cache location therefore uses `expires` only.
- **Basic auth:** the htpasswd file is the source of truth for users; the header only
  mirrors names. Passwords go to the helper via stdin (never argv), hashed with
  `openssl passwd -6`, file 0640 root:nginx (falls back to www-data/0644).
- **Canonical host + TLS:** the certificate must cover the alias domains too; the
  Let's Encrypt dialog opened from a site's menu includes all its domains.
- **Firewall:** `FirewalldRequest` only handles the `http`/`https` services; custom
  ports are opened with `firewall-cmd --add-port` when the user ticks the checkbox.
- **PHP-FPM pools** mirror sites: one ini file per pool with a `; nginx-manager:`
  header (`POOL_HEADER_PREFIX`), `.conf.disabled` when disabled, `php-fpm -t -y
  <mainConf>` + `systemctl reload` with rollback (`saveContent()` in `src/lib/php.ts`).
  Only the *system* PHP is supported: `php_layout()` in the helper picks Fedora's
  `/etc/php-fpm.d` or the newest Debian `/etc/php/<ver>/fpm/pool.d`; Remi SCL and
  parallel versions are out of scope by decision. Worker errors go to the master log
  via `catch_workers_output` (read with `grep -F "[pool NAME]"`), the slow log to
  `/var/log/php-fpm/<pool>-slow.log` (written by the master, so no permission issue),
  sessions to `/var/lib/nginx-manager/php-sessions/<pool>` owned by the pool user
  (`prepare-pool` in the helper). Sockets are owned by the nginx worker user
  (`user` directive of nginx.conf) with mode 0660. New pool users are created with
  `useradd --system --user-group` and a `PHP-FPM pool` GECOS, which is how they
  are recognised in the user list. A site's `phpSocket` matches a pool through
  `poolFastcgi()` (`unix:` + socket path, or `host:port`).

## Conventions

- ESLint config is the starter kit's (4-space indent, semicolons, JSX closing-bracket
  alignment). Run `npx eslint --fix src/` and then fix what remains by hand.
- `tsconfig.json` has `exactOptionalPropertyTypes`. When a prop may receive
  `undefined`, type it `foo?: T | undefined`; use conditional spreads for optional
  PatternFly props. `checkJs` is off because `pkg/lib` JS does not type-check.
- PatternFly packages are pinned to the version used by Cockpit at
  `COCKPIT_REPO_COMMIT` (6.6.1 today). When bumping the commit, align the
  `@patternfly/*` versions with cockpit's `package.json` at that commit, otherwise
  `pkg/lib/cockpit-components-table.tsx` stops type-checking.
- Extra runtime deps added on top of the starter kit: `@patternfly/react-table`, `dequal`.
- All user-visible strings go through `_()` (`cockpit.gettext`), English source text.
  No translations yet; `make po/nginx-manager.pot` needs `gettext` installed.
- Element ids used by tests: `#add-site`, `#site-*` form fields, `[id='site-<name>-menu']`,
  `[id='cert-<id>-menu']`, `tr[data-site=...]`, `tr[data-cert=...]`, `#nginx-service`,
  `#nginx-sites`, `#nginx-certificates`, `#add-pool`, `#pool-*` form fields,
  `[id='pool-<name>-menu']`, `tr[data-pool=...]`, `#php-pools`. Keep them stable or update
  `test/check-application`.

## Build, run, check

```bash
git init -b main          # needed once: make uses git fetch/describe
make                      # fetch pkg/lib, npm install, build dist/
make devel-install        # symlink dist/ into ~/.local/share/cockpit/nginx-manager
make watch                # rebuild on change
npm run eslint && npm run stylelint && npx tsc
make rpm                  # RPM via packaging/cockpit-nginx-manager.spec.in
```

The page only appears in Cockpit's menu when `/usr/sbin/nginx` exists
(`conditions` in `src/manifest.json`). Cockpit needs administrative access
("Limited access" button) for any change.

## Releases and COPR

Versions are SemVer tags without a `v` prefix (`0.1.0`); `make print-version` uses
`git describe --tags`. Releasing is just pushing an annotated tag whose message body
becomes the release notes:

```bash
git tag -a 0.1.0 -m "0.1.0" -m "- first public release"   # 2nd -m = release notes
git push origin 0.1.0
```

`.github/workflows/release.yml` runs `make dist node-cache` and creates the GitHub
release with both tarballs (`Source0`/`Source1` of the spec). The published release
triggers the Packit `copr_build` job (`packit.yaml`) into COPR
`dukerth/cockpit-nginx-manager` for `fedora-all`, `epel-9` and `epel-10`. Packit
rebuilds the SRPM itself from the tag (its `actions`), it does not download the
release assets. One-time setup: Packit GitHub App installed on `soltik-dev`, and the
COPR project listing `github.com/soltik-dev/cockpit-nginx-manager` under
Settings → Integrations → "Packit allowed forge projects".

## Testing without the VM infrastructure

- Templates: bundle `src/lib/templates.ts` with `npx esbuild --bundle --format=esm
  --platform=node`, render a few `SiteConfig`s into a temp `conf.d`, replace
  `/var/log/nginx` with a writable dir, copy `/etc/nginx/fastcgi_params` next to a
  minimal main config (`pid`, `error_log`, `events{}`, `http{ access_log off; include
  conf.d/*.conf; }`) and run `nginx -t -p /etc/nginx/ -c that.conf`. "syntax is ok"
  is the pass signal; the following bind() error is just lack of root.
- Helper: `sed` the `STATE_DIR`/`LE_LIVE`/`CONF_D` (and `PHP_SESSIONS_DIR`, `PHP_LOG_DIR`,
  the `/etc/php-fpm.d` literal) constants to a temp dir and run `python3 helper.py
  <command>` directly (JSON on stdout, errors on stderr).
- Pools: bundle `src/lib/pools.ts` the same way, render into a temp dir, write a main
  config with `[global] pid=... error_log=... include=<tmp>/*.conf` and run
  `php-fpm -t -y that.conf` (works unprivileged as long as the pool user exists).
- Browser tests (`test/check-application`) need `make check` with Cockpit's bots/VMs.

## Environment quirks seen so far

- Fedora 43: `python3-certbot-nginx` fails to load without `python3-pyparsing`.
- `listen [::]:80` makes nginx fail on hosts with IPv6 disabled → the IPv6 checkbox.
- Fedora's `nginx.conf` already declares a `default_server` on port 80; that is why
  `default_server` is not offered yet.
- Fedora: `/var/log/php-fpm` is 0770 apache:root and `/var/lib/php/session` 0770
  root:apache, so pools running as other users cannot write there (hence master log +
  per-pool session dir). `php-fpm -t` needs root on a stock system because of the log.
- On Debian there is no logrotate rule for `/var/log/php-fpm/*-slow.log`; add one if
  slow logs are used heavily there.

## Not done yet / ideas

PHP-FPM: per-pool `php_admin_value` presets beyond the form, pools for non-system
PHP builds (Remi SCL, several versions). Sites/nginx: `default_server` selection,
proxy extras (upstream over HTTPS with self-signed cert,
timeouts, `proxy_buffering off` for SSE), DNS-01 wildcard certificates, HTTP/3,
rate limiting, Spanish translation (`po/es.po`), Fedora dist-git packaging
(`propose_downstream` in `packit.yaml`).
