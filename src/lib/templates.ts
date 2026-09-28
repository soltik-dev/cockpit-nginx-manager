/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Generates nginx server blocks from the site description stored in the
 * "# nginx-manager:" header of each managed file in /etc/nginx/conf.d.
 */

export type SiteType = "static" | "proxy" | "php" | "redirect";

export interface TlsNone {
    mode: "none";
}

export interface TlsCert {
    mode: "cert";
    cert: string;
    key: string;
    redirect: boolean;
    hsts: boolean;
}

export type TlsConfig = TlsNone | TlsCert;

export interface BasicAuth {
    realm: string;
    /* user names only; the hashes live in the htpasswd file */
    users: string[];
}

export interface SiteConfig {
    version: 1;
    name: string;
    type: SiteType;
    domains: string[];
    /* all other domains redirect to this one */
    canonical?: string;

    /* listening; defaults 80 / 443 / all addresses / IPv6 on */
    httpPort?: number;
    httpsPort?: number;
    listenAddress?: string;
    ipv6?: boolean;

    /* static / php */
    root?: string;
    spa?: boolean;
    /* proxy */
    upstream?: string;
    websockets?: boolean;
    /* php */
    phpSocket?: string;
    /* redirect */
    redirectTo?: string;
    redirectKeepPath?: boolean;
    redirectTemporary?: boolean;

    tls: TlsConfig;

    /* access */
    allowFrom?: string[];
    basicAuth?: BasicAuth;

    /* options */
    maxBodySize?: string;
    disableAccessLog?: boolean;
    securityHeaders?: boolean;
    staticCache?: boolean;

    extra?: string;
}

export interface RenderFeatures {
    /* nginx >= 1.25.1 uses the "http2 on;" directive instead of "listen ... http2" */
    http2Directive: boolean;
}

export const HEADER_PREFIX = "# nginx-manager: ";
export const CONF_DIR = "/etc/nginx/conf.d";
export const ACME_WEBROOT = "/var/lib/nginx-manager/acme";
export const HTPASSWD_DIR = "/etc/nginx-manager/htpasswd";
export const LOG_DIR = "/var/log/nginx";
export const DEFAULT_PHP_SOCKET = "unix:/run/php-fpm/www.sock";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DOMAIN_RE = /^(_|[A-Za-z0-9*][A-Za-z0-9*.:-]*)$/;
/* nginx directive values must not contain whitespace or syntax characters */
export const VALUE_RE = /^[^\s;{}"'#]+$/;
export const URL_RE = /^https?:\/\/[^\s;{}"'#]+$/;
export const SIZE_RE = /^\d+[kKmMgG]?$/;
export const IPV4_RE = /^(\d{1,3})(\.\d{1,3}){3}$/;
export const IPV6_RE = /^[0-9A-Fa-f:]+(%[A-Za-z0-9]+)?$/;
export const CIDR_RE = /^(all|(\d{1,3})(\.\d{1,3}){3}(\/\d{1,2})?|[0-9A-Fa-f:]+(\/\d{1,3})?)$/;
export const USER_RE = /^[A-Za-z0-9._@-]+$/;

export const STATIC_ASSETS = "css|js|mjs|map|json|jpe?g|png|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|pdf";

export function siteFile(name: string, enabled: boolean): string {
    return `${CONF_DIR}/${name}.conf${enabled ? "" : ".disabled"}`;
}

export function htpasswdFile(name: string): string {
    return `${HTPASSWD_DIR}/${name}`;
}

export function isValidAddress(addr: string): boolean {
    if (IPV4_RE.test(addr))
        return addr.split(".").every(n => Number(n) <= 255);
    return addr.includes(":") && IPV6_RE.test(addr);
}

export function parseVersion(version: string | null): RenderFeatures {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version || "");
    if (!m)
        return { http2Directive: true };
    const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const http2Directive = major > 1 || (major === 1 && (minor > 25 || (minor === 25 && patch >= 1)));
    return { http2Directive };
}

export function nameFromDomain(domain: string): string {
    const base = domain.replace(/^\*\./, "").replace(/^www\./, "");
    return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "site";
}

export function parseDomains(text: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of text.split(/[\s,]+/)) {
        const d = raw.trim().toLowerCase();
        if (d && !seen.has(d)) {
            seen.add(d);
            result.push(d);
        }
    }
    return result;
}

export function parseList(text: string): string[] {
    return text.split(/[\s,]+/).map(s => s.trim())
            .filter(s => s);
}

function indent(text: string, level: number): string {
    const pad = "    ".repeat(level);
    return text
            .split("\n")
            .map(line => (line.trim() ? pad + line : ""))
            .join("\n");
}

/* Everything the templates derive from a site once, in one place. */
interface Derived {
    site: SiteConfig;
    features: RenderFeatures;
    tls: TlsCert | null;
    redirect: boolean;
    httpPort: number;
    httpsPort: number;
    canonical: string | null;
    mainDomains: string[];
    aliasDomains: string[];
    restricted: boolean;
    auth: boolean;
}

function derive(site: SiteConfig, features: RenderFeatures): Derived {
    const tls = site.tls.mode === "cert" ? site.tls : null;
    const canonical = site.canonical && site.domains.length > 1 && site.domains.includes(site.canonical)
        ? site.canonical
        : null;
    return {
        site,
        features,
        tls,
        redirect: tls !== null && tls.redirect,
        httpPort: site.httpPort || 80,
        httpsPort: site.httpsPort || 443,
        canonical,
        mainDomains: canonical ? [canonical] : site.domains,
        aliasDomains: canonical ? site.domains.filter(d => d !== canonical) : [],
        restricted: !!site.allowFrom && site.allowFrom.length > 0,
        auth: !!site.basicAuth && site.basicAuth.users.length > 0,
    };
}

function listenLines(d: Derived, port: number, ssl: boolean): string[] {
    const suffix = ssl ? " ssl" : "";
    const addr = d.site.listenAddress?.trim();
    if (addr) {
        const host = addr.includes(":") ? `[${addr}]` : addr;
        return [`    listen ${host}:${port}${suffix};`];
    }
    const lines = [`    listen ${port}${suffix};`];
    if (d.site.ipv6 !== false)
        lines.push(`    listen [::]:${port}${suffix};`);
    return lines;
}

function httpsListen(d: Derived): string[] {
    const lines = listenLines(d, d.httpsPort, true);
    if (d.features.http2Directive)
        lines.push("    http2 on;");
    else
        return lines.map(l => l.replace(" ssl;", " ssl http2;"));
    return lines;
}

function sslLines(d: Derived): string[] {
    if (!d.tls)
        return [];
    return [
        `    ssl_certificate ${d.tls.cert};`,
        `    ssl_certificate_key ${d.tls.key};`,
        "    ssl_protocols TLSv1.2 TLSv1.3;",
        "    ssl_prefer_server_ciphers off;",
        "    ssl_session_timeout 1d;",
        "    ssl_session_cache shared:SSL:10m;",
        "    ssl_session_tickets off;",
    ];
}

/* ACME challenges are only reachable on port 80; keep them open despite access restrictions. */
function acmeLocation(d: Derived): string[] {
    if (d.httpPort !== 80)
        return [];
    const lines = [
        "    # ACME HTTP-01 challenges (Let's Encrypt in webroot mode)",
        "    location ^~ /.well-known/acme-challenge/ {",
        `        root ${ACME_WEBROOT};`,
        '        default_type "text/plain";',
    ];
    if (d.restricted)
        lines.push("        allow all;");
    if (d.auth)
        lines.push("        auth_basic off;");
    lines.push("    }");
    return lines;
}

function httpsUrl(d: Derived, host: string): string {
    return `https://${host}${d.httpsPort === 443 ? "" : ":" + d.httpsPort}`;
}

function contentBlock(d: Derived): string[] {
    const site = d.site;
    const lines: string[] = [];
    if (site.type === "static") {
        lines.push(`    root ${site.root};`);
        lines.push("    index index.html index.htm;");
        lines.push("");
        lines.push("    location / {");
        lines.push(site.spa
            ? "        try_files $uri $uri/ /index.html;"
            : "        try_files $uri $uri/ =404;");
        lines.push("    }");
    } else if (site.type === "proxy") {
        lines.push("    location / {");
        lines.push(`        proxy_pass ${site.upstream};`);
        lines.push("        proxy_http_version 1.1;");
        lines.push("        proxy_set_header Host $host;");
        lines.push("        proxy_set_header X-Real-IP $remote_addr;");
        lines.push("        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;");
        lines.push("        proxy_set_header X-Forwarded-Proto $scheme;");
        lines.push("        proxy_set_header X-Forwarded-Host $host;");
        if (site.websockets) {
            lines.push("        # WebSocket support");
            lines.push("        proxy_set_header Upgrade $http_upgrade;");
            lines.push('        proxy_set_header Connection "upgrade";');
            lines.push("        proxy_read_timeout 3600s;");
        }
        lines.push("    }");
    } else if (site.type === "php") {
        lines.push(`    root ${site.root};`);
        lines.push("    index index.php index.html index.htm;");
        lines.push("");
        lines.push("    location / {");
        lines.push("        try_files $uri $uri/ /index.php$is_args$args;");
        lines.push("    }");
        lines.push("");
        lines.push("    location ~ \\.php$ {");
        lines.push("        try_files $uri =404;");
        lines.push("        include fastcgi_params;");
        lines.push(`        fastcgi_pass ${site.phpSocket || DEFAULT_PHP_SOCKET};`);
        lines.push("        fastcgi_index index.php;");
        lines.push("        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;");
        lines.push("    }");
    } else if (site.type === "redirect") {
        const code = site.redirectTemporary ? 302 : 301;
        const keep = site.redirectKeepPath !== false;
        const target = keep ? (site.redirectTo || "").replace(/\/+$/, "") + "$request_uri" : site.redirectTo;
        lines.push("    location / {");
        lines.push(`        return ${code} ${target};`);
        lines.push("    }");
    }
    if (site.staticCache && (site.type === "static" || site.type === "php")) {
        lines.push("");
        lines.push("    # Long-lived caching for static assets");
        lines.push(`    location ~* \\.(?:${STATIC_ASSETS})$ {`);
        lines.push("        expires 30d;");
        lines.push("        try_files $uri =404;");
        lines.push("    }");
    }
    if (site.type === "static" || site.type === "php") {
        lines.push("");
        lines.push("    # Never serve hidden files (except ACME challenges)");
        lines.push("    location ~ /\\.(?!well-known) {");
        lines.push("        deny all;");
        lines.push("    }");
    }
    return lines;
}

function accessLines(d: Derived): string[] {
    const site = d.site;
    const lines: string[] = [];
    if (d.restricted && site.allowFrom) {
        lines.push("    # Only these networks may connect");
        for (const net of site.allowFrom)
            lines.push(`    allow ${net};`);
        lines.push("    deny all;");
        lines.push("");
    }
    if (d.auth && site.basicAuth) {
        lines.push(`    auth_basic "${site.basicAuth.realm.replace(/"/g, "")}";`);
        lines.push(`    auth_basic_user_file ${htpasswdFile(site.name)};`);
        lines.push("");
    }
    return lines;
}

function logLines(d: Derived): string[] {
    return [
        d.site.disableAccessLog ? "    access_log off;" : `    access_log ${LOG_DIR}/${d.site.name}.access.log;`,
        `    error_log ${LOG_DIR}/${d.site.name}.error.log;`,
    ];
}

function optionLines(d: Derived): string[] {
    const site = d.site;
    const lines: string[] = [];
    if (site.maxBodySize)
        lines.push(`    client_max_body_size ${site.maxBodySize};`);
    if (site.securityHeaders) {
        lines.push('    add_header X-Content-Type-Options "nosniff" always;');
        lines.push('    add_header X-Frame-Options "SAMEORIGIN" always;');
        lines.push('    add_header Referrer-Policy "strict-origin-when-cross-origin" always;');
    }
    if (lines.length)
        lines.push("");
    return lines;
}

export function renderSite(site: SiteConfig, features: RenderFeatures): string {
    const d = derive(site, features);
    const out: string[] = [];

    out.push("# Managed by Cockpit Nginx Manager (cockpit-nginx-manager).");
    out.push("# This file is regenerated whenever the site is saved from Cockpit.");
    out.push("# Remove the following line to take manual control of this file.");
    out.push(HEADER_PREFIX + JSON.stringify(site));
    out.push("");

    /* HTTP -> HTTPS redirect for the main domains */
    if (d.redirect) {
        out.push("server {");
        out.push(...listenLines(d, d.httpPort, false));
        out.push(`    server_name ${d.mainDomains.join(" ")};`);
        out.push("");
        const acme = acmeLocation(d);
        if (acme.length) {
            out.push(...acme);
            out.push("");
        }
        out.push("    location / {");
        out.push(`        return 301 ${httpsUrl(d, "$host")}$request_uri;`);
        out.push("    }");
        out.push("}");
        out.push("");
    }

    /* alias domains -> canonical host */
    if (d.canonical && d.aliasDomains.length) {
        const target = d.tls
            ? httpsUrl(d, d.canonical)
            : `$scheme://${d.canonical}${d.httpPort === 80 ? "" : ":" + d.httpPort}`;
        out.push("# Redirect alias domains to the canonical host");
        out.push("server {");
        out.push(...listenLines(d, d.httpPort, false));
        if (d.tls)
            out.push(...httpsListen(d));
        out.push(`    server_name ${d.aliasDomains.join(" ")};`);
        out.push("");
        if (d.tls) {
            out.push(...sslLines(d));
            out.push("");
        }
        const acme = acmeLocation(d);
        if (acme.length) {
            out.push(...acme);
            out.push("");
        }
        out.push("    location / {");
        out.push(`        return 301 ${target}$request_uri;`);
        out.push("    }");
        out.push("}");
        out.push("");
    }

    /* the site itself */
    out.push("server {");
    if (!d.redirect)
        out.push(...listenLines(d, d.httpPort, false));
    if (d.tls)
        out.push(...httpsListen(d));
    out.push(`    server_name ${d.mainDomains.join(" ")};`);
    out.push("");
    if (d.tls) {
        out.push(...sslLines(d));
        if (d.tls.hsts && d.redirect)
            out.push('    add_header Strict-Transport-Security "max-age=63072000" always;');
        out.push("");
    }
    out.push(...logLines(d));
    out.push("");
    out.push(...optionLines(d));
    out.push(...accessLines(d));
    if (!d.redirect) {
        const acme = acmeLocation(d);
        if (acme.length) {
            out.push(...acme);
            out.push("");
        }
    }
    out.push(...contentBlock(d));
    if (site.extra && site.extra.trim()) {
        out.push("");
        out.push("    # Custom directives");
        out.push(indent(site.extra.trim(), 1));
    }
    out.push("}");
    out.push("");
    return out.join("\n");
}

export function isManagedContent(content: string): boolean {
    return content.split("\n").some(line => line.startsWith(HEADER_PREFIX));
}

/* Log files of a site: managed ones follow the naming scheme, others are parsed from the file. */
export function logFiles(name: string, meta: SiteConfig | null, content: string): { access: string | null, error: string } {
    if (meta) {
        return {
            access: meta.disableAccessLog ? null : `${LOG_DIR}/${name}.access.log`,
            error: `${LOG_DIR}/${name}.error.log`,
        };
    }
    const access = /^\s*access_log\s+(\S+)/m.exec(content);
    const error = /^\s*error_log\s+(\S+)/m.exec(content);
    return {
        access: access ? (access[1] === "off;" || access[1] === "off" ? null : access[1].replace(/;$/, "")) : `${LOG_DIR}/access.log`,
        error: error ? error[1].replace(/;$/, "") : `${LOG_DIR}/error.log`,
    };
}
