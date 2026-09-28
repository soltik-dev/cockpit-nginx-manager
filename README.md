# Cockpit Nginx Manager

Cockpit module to manage **nginx** sites and **TLS certificates** from the web console.

- List, create, edit, enable/disable and delete virtual hosts stored as one file per
  site in `/etc/nginx/conf.d/`, generated from templates: static website
  (optionally single-page app), reverse proxy (with WebSocket support), PHP-FPM
  and plain redirects.
- Per-site options: HTTP/HTTPS ports, bind address, IPv6 on/off, canonical host
  (www to bare domain and the like), allowed networks, HTTP basic authentication
  with user management, maximum upload size, security headers, static asset
  caching, access log on/off, and free-form extra directives.
- Log viewer for each site's access and error log.
- **PHP-FPM pools**: list, create, edit, enable/disable and delete pools of the
  system PHP (Fedora `/etc/php-fpm.d`, Debian `/etc/php/<ver>/fpm/pool.d`): user
  (optionally created as a system account), Unix socket or TCP, process manager
  and worker limits, PHP limits (`memory_limit`, uploads, execution time,
  `open_basedir`, time zone), slow log, and extra directives. PHP sites pick
  their pool from a list. Pool changes are validated with `php-fpm -t` and
  rolled back on failure, like sites.
- Every change is validated with `nginx -t` before nginx is reloaded. If validation
  fails the previous file is restored, so nginx is never left with a broken configuration.
- Request Let's Encrypt certificates through `certbot` (nginx plugin, webroot or
  standalone validation), renew them, or create self-signed certificates for
  internal hosts. Certificates can be attached to a site straight from its menu.
- Files that were not created by this module still show up and can be edited as
  text, enabled, disabled or deleted.
- Service card: status, start/stop/restart/reload, start on boot, configuration test,
  plus firewall hints for HTTP/HTTPS.

Built on the [Cockpit starter kit](https://github.com/cockpit-project/starter-kit)
(React + PatternFly + esbuild).

## How it works

- **Managed sites** carry their settings as JSON in a header comment
  (`# nginx-manager: {...}`) at the top of `/etc/nginx/conf.d/<name>.conf`. The
  file is regenerated from that data whenever the site is saved from the form.
  Remove the header line to take manual control of a file.
- **Disabled sites** are renamed to `<name>.conf.disabled`, which nginx's
  `include conf.d/*.conf` ignores.
- **Let's Encrypt** certificates live in `/etc/letsencrypt/live/<name>/` and are
  requested with `certbot certonly ... --deploy-hook "systemctl reload nginx"`.
  Renewal is left to certbot's systemd timer.
- **PHP-FPM pools** are ini files with a `; nginx-manager: {...}` header in the
  distribution's pool directory. Worker output goes to the php-fpm master log
  (`catch_workers_output`), prefixed with the pool name, so per-pool logs need no
  special permissions; the slow log is written by the master process to
  `/var/log/php-fpm/<pool>-slow.log`. Each pool gets its own session directory
  `/var/lib/nginx-manager/php-sessions/<pool>` owned by the pool user, because
  the distribution's session directory is only writable by the default pool user.
- **Basic authentication** users are stored hashed (SHA-512 crypt, via
  `openssl passwd -6`) in `/etc/nginx-manager/htpasswd/<site>`, readable only by
  root and the nginx group.
- **Self-signed** certificates are created with `openssl` in
  `/etc/nginx-manager/certs/<name>/` using the same `fullchain.pem`/`privkey.pem`
  layout.
- Managed sites always serve `/.well-known/acme-challenge/` from
  `/var/lib/nginx-manager/acme` so webroot validation works even when HTTP
  redirects to HTTPS.
- All system access goes through `cockpit.spawn()`/`cockpit.file()` with Cockpit's
  administrative access; there is no daemon. A small Python helper
  (`src/nginx-manager.py`) is bundled into the page and executed with `python3 -c`.

## Development dependencies

On Fedora/RHEL:

    sudo dnf install cockpit make nodejs npm gettext libappstream-glib

## Building and running from source

    git clone https://github.com/soltik-dev/cockpit-nginx-manager.git
    cd cockpit-nginx-manager
    make

`make` downloads the shared Cockpit build tooling (`pkg/lib`) on first run,
installs the npm dependencies and builds the bundle into `dist/`.

For development, link the built bundle into your user's Cockpit directory and
rebuild automatically on every change:

    make devel-install
    make watch

Then open Cockpit (https://localhost:9090) and look for **Nginx** in the menu
(it is only listed on machines where `/usr/sbin/nginx` exists). Remove the
development link with `make devel-uninstall`.

Checks:

    npm run eslint
    npm run stylelint
    npx tsc

## Installing system-wide

    sudo make install

or build an RPM:

    make rpm
    sudo dnf install ./cockpit-nginx-manager-*.rpm

## Runtime requirements

- `cockpit-bridge`, `python3`
- `nginx`
- `certbot` and `python3-certbot-nginx` (only for Let's Encrypt; on Fedora 43
  `python3-pyparsing` is also needed for the nginx plugin)
- `openssl` (for self-signed certificates)
- `php-fpm` (only for the PHP-FPM pools card)

## License

LGPL-2.1-or-later, see [LICENSE](LICENSE).
