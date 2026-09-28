# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Helper for cockpit-nginx-manager. Bundled as text and executed through
# `python3 -c SCRIPT COMMAND [ARGS...]` by cockpit.spawn(), as root when the
# user has administrative access. Prints a JSON document on stdout; on failure
# exits non-zero with a message on stderr.

import datetime
import glob
import grp
import ipaddress
import json
import os
import pwd
import re
import shutil
import subprocess
import sys

CONF_D = "/etc/nginx/conf.d"
LE_LIVE = "/etc/letsencrypt/live"
STATE_DIR = "/etc/nginx-manager"
SELF_DIR = os.path.join(STATE_DIR, "certs")
HTPASSWD_DIR = os.path.join(STATE_DIR, "htpasswd")
PHP_SESSIONS_DIR = "/var/lib/nginx-manager/php-sessions"
PHP_LOG_DIR = "/var/log/php-fpm"
POOL_HEADER = "; nginx-manager: "
ACME_WEBROOT = "/var/lib/nginx-manager/acme"
HEADER = "# nginx-manager: "
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
USER_RE = re.compile(r"^[A-Za-z0-9._@-]+$")
PLACEHOLDER_INDEX = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>%(name)s</title></head>
<body>
<h1>%(name)s</h1>
<p>This site was created with Cockpit Nginx Manager. Replace this file with your content.</p>
</body>
</html>
"""


def fail(message, code=1):
    sys.stderr.write(message + "\n")
    sys.exit(code)


def check_name(name):
    if not NAME_RE.match(name) or ".." in name:
        fail("invalid name: %r" % name)


def list_sites():
    sites = []
    if not os.path.isdir(CONF_D):
        return sites
    for fn in sorted(os.listdir(CONF_D)):
        path = os.path.join(CONF_D, fn)
        if not os.path.isfile(path):
            continue
        if fn.endswith(".conf"):
            enabled, base = True, fn[:-len(".conf")]
        elif fn.endswith(".conf.disabled"):
            enabled, base = False, fn[:-len(".conf.disabled")]
        else:
            continue
        error = None
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError as e:
            content = ""
            error = str(e)
        meta = None
        for line in content.splitlines():
            if line.startswith(HEADER):
                try:
                    meta = json.loads(line[len(HEADER):])
                except ValueError:
                    meta = None
                break
        server_names = []
        for m in re.finditer(r"^\s*server_name\s+([^;]+);", content, re.M):
            for n in m.group(1).split():
                if n not in server_names:
                    server_names.append(n)
        sites.append({
            "file": path,
            "name": base,
            "enabled": enabled,
            "content": content,
            "meta": meta if isinstance(meta, dict) else None,
            "serverNames": server_names,
            "hasServer": re.search(r"^\s*server\s*\{", content, re.M) is not None,
            "mtime": os.path.getmtime(path),
            "error": error,
        })
    return sites


def parse_openssl_date(text):
    # e.g. "Sep 25 12:00:00 2026 GMT"
    try:
        d = datetime.datetime.strptime(text.strip(), "%b %d %H:%M:%S %Y GMT")
    except ValueError:
        return None
    return d.replace(tzinfo=datetime.timezone.utc).isoformat()


def cert_info(cert_path):
    info = {"subject": "", "issuer": "", "cn": "", "notBefore": None, "notAfter": None,
            "daysLeft": None, "sans": [], "selfSigned": False, "error": None}
    env = dict(os.environ, LC_ALL="C")
    try:
        r = subprocess.run(["openssl", "x509", "-in", cert_path, "-noout", "-subject", "-issuer",
                            "-startdate", "-enddate", "-ext", "subjectAltName"],
                           capture_output=True, text=True, env=env)
    except OSError as e:
        info["error"] = str(e)
        return info
    if r.returncode != 0:
        info["error"] = r.stderr.strip() or "openssl x509 failed"
        return info
    for line in r.stdout.splitlines():
        line = line.strip()
        if line.startswith("subject="):
            info["subject"] = line[len("subject="):].strip()
        elif line.startswith("issuer="):
            info["issuer"] = line[len("issuer="):].strip()
        elif line.startswith("notBefore="):
            info["notBefore"] = parse_openssl_date(line[len("notBefore="):])
        elif line.startswith("notAfter="):
            info["notAfter"] = parse_openssl_date(line[len("notAfter="):])
        elif "DNS:" in line or "IP Address:" in line:
            for part in line.split(","):
                part = part.strip()
                if part.startswith("DNS:"):
                    info["sans"].append(part[len("DNS:"):])
                elif part.startswith("IP Address:"):
                    info["sans"].append(part[len("IP Address:"):])
    m = re.search(r"CN\s*=\s*([^,/]+)", info["subject"])
    info["cn"] = m.group(1).strip() if m else ""
    info["selfSigned"] = info["subject"] == info["issuer"]
    if info["notAfter"]:
        expires = datetime.datetime.fromisoformat(info["notAfter"])
        info["daysLeft"] = (expires - datetime.datetime.now(datetime.timezone.utc)).days
    return info


def list_cert_dir(base, source, prefix):
    certs, errors = [], []
    if not os.path.isdir(base):
        return certs, errors
    try:
        names = sorted(os.listdir(base))
    except OSError as e:
        return certs, ["%s: %s" % (base, e.strerror or e)]
    for n in names:
        d = os.path.join(base, n)
        cert = os.path.join(d, "fullchain.pem")
        key = os.path.join(d, "privkey.pem")
        if not os.path.isdir(d) or not os.path.exists(cert):
            continue
        entry = {"id": prefix + n, "source": source, "name": n, "cert": cert, "key": key}
        entry.update(cert_info(cert))
        certs.append(entry)
    return certs, errors


def list_certs():
    le, le_errors = list_cert_dir(LE_LIVE, "letsencrypt", "le:")
    own, own_errors = list_cert_dir(SELF_DIR, "selfsigned", "self:")
    return {
        "certs": le + own,
        "errors": le_errors + own_errors,
        "certbot": shutil.which("certbot") is not None,
        "openssl": shutil.which("openssl") is not None,
        "acmeWebroot": ACME_WEBROOT,
        "selfSignedDir": SELF_DIR,
    }


def is_ip(text):
    try:
        ipaddress.ip_address(text)
        return True
    except ValueError:
        return False


def selfsigned(name, days, domains):
    check_name(name)
    if not domains:
        fail("at least one domain is required")
    for d in domains:
        if re.search(r"[\s,;/\\]", d):
            fail("invalid domain: %r" % d)
    if days < 1 or days > 36500:
        fail("invalid validity period")
    target = os.path.join(SELF_DIR, name)
    if os.path.exists(target):
        fail("a self-signed certificate named %r already exists" % name)
    os.makedirs(SELF_DIR, mode=0o755, exist_ok=True)
    os.makedirs(target, mode=0o755)
    cert = os.path.join(target, "fullchain.pem")
    key = os.path.join(target, "privkey.pem")
    san = ",".join(("IP:" if is_ip(d) else "DNS:") + d for d in domains)
    cn = domains[0][:64]
    r = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
                        "-days", str(days), "-keyout", key, "-out", cert,
                        "-subj", "/CN=" + cn, "-addext", "subjectAltName=" + san],
                       capture_output=True, text=True)
    if r.returncode != 0:
        shutil.rmtree(target, ignore_errors=True)
        fail(r.stderr.strip() or "openssl req failed")
    os.chmod(key, 0o600)
    os.chmod(cert, 0o644)
    return {"cert": cert, "key": key}


def delete_selfsigned(name):
    check_name(name)
    target = os.path.join(SELF_DIR, name)
    if not os.path.isdir(target):
        fail("no self-signed certificate named %r" % name)
    shutil.rmtree(target)
    return {"deleted": target}


def htpasswd(name):
    """Apply {"set": {user: password}, "remove": [user]} from stdin to the site's htpasswd file."""
    check_name(name)
    raw = sys.stdin.read().strip()
    changes = json.loads(raw) if raw else {}
    path = os.path.join(HTPASSWD_DIR, name)
    users = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if ":" in line:
                    user, digest = line.split(":", 1)
                    users[user] = digest
    for user in changes.get("remove") or []:
        users.pop(user, None)
    for user, password in (changes.get("set") or {}).items():
        if not USER_RE.match(user):
            fail("invalid user name: %r" % user)
        if not password:
            fail("empty password for %r" % user)
        r = subprocess.run(["openssl", "passwd", "-6", "-stdin"], input=password + "\n",
                           capture_output=True, text=True)
        if r.returncode != 0 or not r.stdout.strip():
            fail(r.stderr.strip() or "openssl passwd failed")
        users[user] = r.stdout.strip().splitlines()[0]
    if changes:
        os.makedirs(HTPASSWD_DIR, mode=0o755, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for user in sorted(users):
                f.write("%s:%s\n" % (user, users[user]))
        # readable by the nginx workers, nobody else
        gid = None
        for group in ("nginx", "www-data", "http"):
            try:
                gid = grp.getgrnam(group).gr_gid
                break
            except KeyError:
                continue
        try:
            if gid is not None and os.geteuid() == 0:
                os.chown(tmp, 0, gid)
                os.chmod(tmp, 0o640)
            else:
                os.chmod(tmp, 0o644)
        except OSError:
            os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    return {"file": path, "users": sorted(users)}


def ensure_root(path, name):
    path = os.path.normpath(path)
    if not os.path.isabs(path) or path == "/":
        fail("invalid document root: %r" % path)
    if os.path.isdir(path):
        return {"created": False}
    os.makedirs(path, mode=0o755)
    index = os.path.join(path, "index.html")
    with open(index, "w", encoding="utf-8") as f:
        f.write(PLACEHOLDER_INDEX % {"name": name})
    os.chmod(index, 0o644)
    return {"created": True}


def ensure_dir(path):
    path = os.path.normpath(path)
    if not os.path.isabs(path) or path == "/":
        fail("invalid directory: %r" % path)
    os.makedirs(path, mode=0o755, exist_ok=True)
    return {"path": path}


# ---------------------------------------------------------------- PHP-FPM


def php_layout():
    """Locate the system PHP-FPM: Fedora/RHEL first, then the newest Debian/Ubuntu version."""
    if os.path.isdir("/etc/php-fpm.d"):
        return {
            "poolDir": "/etc/php-fpm.d",
            "mainConf": "/etc/php-fpm.conf",
            "service": "php-fpm.service",
            "binary": shutil.which("php-fpm") or "/usr/sbin/php-fpm",
            "runDir": "/run/php-fpm",
            "masterLog": "/var/log/php-fpm/error.log",
        }
    debian = sorted(glob.glob("/etc/php/*/fpm/pool.d"),
                    key=lambda d: [int(x) if x.isdigit() else x for x in d.split("/")[3].split(".")])
    if debian:
        ver = debian[-1].split("/")[3]
        return {
            "poolDir": debian[-1],
            "mainConf": "/etc/php/%s/fpm/php-fpm.conf" % ver,
            "service": "php%s-fpm.service" % ver,
            "binary": "/usr/sbin/php-fpm%s" % ver,
            "runDir": "/run/php",
            "masterLog": "/var/log/php%s-fpm.log" % ver,
        }
    return None


def web_user():
    try:
        with open("/etc/nginx/nginx.conf", encoding="utf-8", errors="replace") as f:
            m = re.search(r"^\s*user\s+([^\s;]+)", f.read(), re.M)
        if m:
            return m.group(1)
    except OSError:
        pass
    for name in ("nginx", "www-data", "http"):
        try:
            pwd.getpwnam(name)
            return name
        except KeyError:
            continue
    return "nginx"


def system_users():
    users = []
    for entry in pwd.getpwall():
        interactive = 1000 <= entry.pw_uid < 65000 and not entry.pw_shell.endswith(("nologin", "false"))
        web = entry.pw_name in ("apache", "nginx", "www-data", "http")
        pool_user = entry.pw_gecos.startswith("PHP-FPM pool")
        if interactive or web or pool_user:
            try:
                group = grp.getgrgid(entry.pw_gid).gr_name
            except KeyError:
                group = str(entry.pw_gid)
            users.append({"name": entry.pw_name, "group": group})
    return sorted(users, key=lambda u: u["name"])


def php_info():
    layout = php_layout()
    if not layout:
        return {"available": False}
    version = None
    try:
        r = subprocess.run([layout["binary"], "-v"], capture_output=True, text=True)
        m = re.search(r"PHP (\d+\.\d+\.\d+)", r.stdout + r.stderr)
        if m:
            version = m.group(1)
    except OSError:
        pass
    # the master log is where worker output ends up
    try:
        with open(layout["mainConf"], encoding="utf-8", errors="replace") as f:
            m = re.search(r"^\s*error_log\s*=\s*(\S+)", f.read(), re.M)
        if m and os.path.isabs(m.group(1)):
            layout["masterLog"] = m.group(1)
    except OSError:
        pass
    layout.update({
        "available": True,
        "version": version,
        "logDir": PHP_LOG_DIR,
        "sessionsDir": PHP_SESSIONS_DIR,
        "webUser": web_user(),
        "users": system_users(),
    })
    return layout


POOL_DIRECTIVES = ("user", "group", "listen", "pm", "pm.max_children", "pm.start_servers",
                   "pm.min_spare_servers", "pm.max_spare_servers", "pm.process_idle_timeout",
                   "slowlog", "request_slowlog_timeout")


def list_pools():
    layout = php_layout()
    pools = []
    if not layout or not os.path.isdir(layout["poolDir"]):
        return pools
    for fn in sorted(os.listdir(layout["poolDir"])):
        path = os.path.join(layout["poolDir"], fn)
        if not os.path.isfile(path):
            continue
        if fn.endswith(".conf"):
            enabled, base = True, fn[:-len(".conf")]
        elif fn.endswith(".conf.disabled"):
            enabled, base = False, fn[:-len(".conf.disabled")]
        else:
            continue
        error = None
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError as e:
            content = ""
            error = str(e)
        meta = None
        section = None
        directives = {}
        for line in content.splitlines():
            if line.startswith(POOL_HEADER):
                try:
                    meta = json.loads(line[len(POOL_HEADER):])
                except ValueError:
                    meta = None
                continue
            stripped = line.split(";", 1)[0].strip()
            if not stripped:
                continue
            m = re.match(r"^\[(.+)\]$", stripped)
            if m:
                if section is None:
                    section = m.group(1)
                continue
            if "=" in stripped:
                key, value = stripped.split("=", 1)
                key = key.strip()
                if key in POOL_DIRECTIVES and key not in directives:
                    directives[key] = value.strip()
        pools.append({
            "file": path,
            "name": base,
            "section": section or base,
            "enabled": enabled,
            "content": content,
            "meta": meta if isinstance(meta, dict) else None,
            "directives": directives,
            "mtime": os.path.getmtime(path),
            "error": error,
        })
    return pools


def ensure_user(name):
    if not re.match(r"^[a-z_][a-z0-9_-]{0,31}$", name):
        fail("invalid user name: %r" % name)
    try:
        entry = pwd.getpwnam(name)
        return {"created": False, "group": grp.getgrgid(entry.pw_gid).gr_name}
    except KeyError:
        pass
    nologin = shutil.which("nologin") or "/sbin/nologin"
    r = subprocess.run(["useradd", "--system", "--user-group", "--no-create-home", "--shell", nologin,
                        "--comment", "PHP-FPM pool %s" % name, name], capture_output=True, text=True)
    if r.returncode != 0:
        fail(r.stderr.strip() or "useradd failed")
    entry = pwd.getpwnam(name)
    return {"created": True, "group": grp.getgrgid(entry.pw_gid).gr_name}


def prepare_pool(name, user, group):
    """Create the per-pool directories that the pool's user must be able to write to."""
    check_name(name)
    try:
        uid = pwd.getpwnam(user).pw_uid
    except KeyError:
        fail("no such user: %r" % user)
    try:
        gid = grp.getgrnam(group).gr_gid
    except KeyError:
        fail("no such group: %r" % group)
    os.makedirs(PHP_LOG_DIR, mode=0o755, exist_ok=True)
    os.makedirs(PHP_SESSIONS_DIR, mode=0o711, exist_ok=True)
    sessions = os.path.join(PHP_SESSIONS_DIR, name)
    os.makedirs(sessions, mode=0o700, exist_ok=True)
    if os.geteuid() == 0:
        os.chown(sessions, uid, gid)
        os.chmod(sessions, 0o700)
    return {"sessionDir": sessions}


def delete_pool_data(name):
    check_name(name)
    sessions = os.path.join(PHP_SESSIONS_DIR, name)
    if os.path.isdir(sessions):
        shutil.rmtree(sessions)
    return {"deleted": sessions}


def nginx_info():
    version = None
    try:
        r = subprocess.run(["nginx", "-v"], capture_output=True, text=True)
        m = re.search(r"nginx/(\d+\.\d+\.\d+)", r.stderr + r.stdout)
        if m:
            version = m.group(1)
    except OSError:
        pass
    sockets = sorted(glob.glob("/run/php-fpm/*.sock") + glob.glob("/run/php/*.sock"))
    return {
        "version": version,
        "phpSockets": ["unix:" + s for s in sockets],
        "certbot": shutil.which("certbot") is not None,
        "openssl": shutil.which("openssl") is not None,
        "confDir": CONF_D,
        "acmeWebroot": ACME_WEBROOT,
    }


def main(argv):
    cmd = argv[0] if argv else ""
    args = argv[1:]
    if cmd == "list-sites":
        out = list_sites()
    elif cmd == "list-certs":
        out = list_certs()
    elif cmd == "nginx-info":
        out = nginx_info()
    elif cmd == "selfsigned" and len(args) >= 3:
        out = selfsigned(args[0], int(args[1]), args[2:])
    elif cmd == "delete-selfsigned" and len(args) == 1:
        out = delete_selfsigned(args[0])
    elif cmd == "ensure-root" and len(args) == 2:
        out = ensure_root(args[0], args[1])
    elif cmd == "ensure-dir" and len(args) == 1:
        out = ensure_dir(args[0])
    elif cmd == "htpasswd" and len(args) == 1:
        out = htpasswd(args[0])
    elif cmd == "php-info":
        out = php_info()
    elif cmd == "list-pools":
        out = list_pools()
    elif cmd == "ensure-user" and len(args) == 1:
        out = ensure_user(args[0])
    elif cmd == "prepare-pool" and len(args) == 3:
        out = prepare_pool(args[0], args[1], args[2])
    elif cmd == "delete-pool-data" and len(args) == 1:
        out = delete_pool_data(args[0])
    else:
        fail("usage: COMMAND [ARGS...]; unknown command %r" % cmd, 2)
    json.dump(out, sys.stdout)


main(sys.argv[1:])
