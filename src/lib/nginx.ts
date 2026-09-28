/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * System access layer: everything that talks to the machine goes through here.
 */

import cockpit from "cockpit";

import helperScript from "../nginx-manager.py";
import { SiteConfig, RenderFeatures, renderSite, siteFile, htpasswdFile, CONF_DIR } from "./templates";

const _ = cockpit.gettext;

export interface SiteEntry {
    file: string;
    name: string;
    enabled: boolean;
    content: string;
    meta: SiteConfig | null;
    serverNames: string[];
    hasServer: boolean;
    mtime: number;
    error: string | null;
}

export type CertSource = "letsencrypt" | "selfsigned";

export interface CertInfo {
    id: string;
    source: CertSource;
    name: string;
    cert: string;
    key: string;
    subject: string;
    issuer: string;
    cn: string;
    notBefore: string | null;
    notAfter: string | null;
    daysLeft: number | null;
    sans: string[];
    selfSigned: boolean;
    error: string | null;
}

export interface CertList {
    certs: CertInfo[];
    errors: string[];
    certbot: boolean;
    openssl: boolean;
    acmeWebroot: string;
    selfSignedDir: string;
}

export interface NginxInfo {
    version: string | null;
    phpSockets: string[];
    certbot: boolean;
    openssl: boolean;
    confDir: string;
    acmeWebroot: string;
}

export interface RunResult {
    ok: boolean;
    status: number | null;
    output: string;
    message: string;
}

export function errorMessage(ex: unknown): string {
    if (typeof ex === "string")
        return ex;
    if (ex && typeof ex === "object") {
        const e = ex as { problem?: string | null; message?: string; toString?: () => string };
        if (e.problem)
            return cockpit.message(e.problem);
        if (e.message)
            return e.message;
    }
    return String(ex);
}

/* Run a command, capturing stdout+stderr, never rejecting. */
export function run(args: string[], options: Omit<cockpit.SpawnOptions, "binary"> = {}, onOutput?: (chunk: string) => void): Promise<RunResult> {
    return new Promise(resolve => {
        let output = "";
        const proc = cockpit.spawn(args, { superuser: "require", err: "out", ...options });
        proc.stream(chunk => {
            output += chunk;
            if (onOutput)
                onOutput(chunk);
        });
        proc
                .then(() => resolve({ ok: true, status: 0, output, message: "" }))
                .catch((ex: cockpit.ProcessError) => resolve({
                    ok: false,
                    status: ex.exit_status,
                    output,
                    message: ex.problem ? cockpit.message(ex.problem) : (ex.message || ""),
                }));
    });
}

export async function helper<T>(args: string[], superuser: cockpit.SuperuserMode = "try", input?: string): Promise<T> {
    try {
        const proc = cockpit.spawn(["python3", "-c", helperScript, ...args],
                                   { superuser, err: "message", environ: ["LC_ALL=C.UTF-8"] });
        if (input !== undefined)
            proc.input(input);
        const out = await proc;
        return JSON.parse(out) as T;
    } catch (ex) {
        throw new Error(errorMessage(ex));
    }
}

export const listSites = () => helper<SiteEntry[]>(["list-sites"]);
export const listCerts = () => helper<CertList>(["list-certs"]);
export const nginxInfo = () => helper<NginxInfo>(["nginx-info"]);

export async function readFile(path: string): Promise<string> {
    const f = cockpit.file(path, { superuser: "try" });
    try {
        return (await f.read()) ?? "";
    } finally {
        f.close();
    }
}

export async function writeFile(path: string, content: string): Promise<void> {
    const f = cockpit.file(path, { superuser: "require" });
    try {
        await f.replace(content);
    } catch (ex) {
        throw new Error(cockpit.format("$0: $1", path, errorMessage(ex)));
    } finally {
        f.close();
    }
}

export function failed(result: RunResult, fallback: string): Error {
    const text = result.output.trim() || result.message || fallback;
    return new Error(text);
}

export async function isActive(unit = "nginx.service"): Promise<boolean> {
    const r = await run(["systemctl", "is-active", "--quiet", unit], { superuser: "try" });
    return r.ok;
}

export function testConfig(): Promise<RunResult> {
    return run(["nginx", "-t"]);
}

export function serviceAction(verb: "start" | "stop" | "restart" | "reload" | "enable" | "disable"): Promise<RunResult> {
    const args = verb === "enable" || verb === "disable"
        ? ["systemctl", verb, "--now", "nginx.service"]
        : ["systemctl", verb, "nginx.service"];
    return run(args);
}

/* Validate the configuration and reload nginx if it is running. Throws with nginx's output on failure. */
async function testAndReload(): Promise<void> {
    const test = await testConfig();
    if (!test.ok)
        throw failed(test, "nginx -t failed");
    if (await isActive()) {
        const reload = await run(["systemctl", "reload", "nginx.service"]);
        if (!reload.ok)
            throw failed(reload, "reloading nginx failed");
    }
}

export async function removeFile(path: string): Promise<void> {
    const r = await run(["rm", "-f", "--", path]);
    if (!r.ok)
        throw failed(r, "removing file failed");
}

export async function moveFile(from: string, to: string): Promise<void> {
    const r = await run(["mv", "-T", "--", from, to]);
    if (!r.ok)
        throw failed(r, "renaming file failed");
}

export interface HtpasswdChanges {
    set?: Record<string, string>;
    remove?: string[];
}

/* Apply user changes to the site's htpasswd file; returns the resulting user names. */
export async function setHtpasswd(name: string, changes: HtpasswdChanges): Promise<string[]> {
    const r = await helper<{ users: string[] }>(["htpasswd", name], "require", JSON.stringify(changes));
    return r.users;
}

export async function listHtpasswd(name: string): Promise<string[]> {
    const r = await helper<{ users: string[] }>(["htpasswd", name], "try", "");
    return r.users;
}

export interface SaveOptions {
    previous?: SiteEntry | undefined;
    createRoot?: boolean;
    features: RenderFeatures;
    /* user changes to apply to the htpasswd file before writing the configuration */
    htpasswd?: HtpasswdChanges | undefined;
    /* TCP ports to open in firewalld after a successful save */
    openPorts?: number[] | undefined;
}

/*
 * Write the generated configuration for SITE. When editing, the file keeps
 * its enabled/disabled state. If nginx rejects the result, the previous
 * content is restored (or the new file removed) before throwing.
 */
export async function saveSite(site: SiteConfig, options: SaveOptions): Promise<void> {
    if (options.htpasswd && site.basicAuth) {
        const users = await setHtpasswd(site.name, options.htpasswd);
        site = { ...site, basicAuth: { ...site.basicAuth, users } };
    }
    const content = renderSite(site, options.features);
    await saveContent(site.name, content, options, site.root);

    for (const port of options.openPorts || []) {
        const r = await run(["firewall-cmd", "--permanent", `--add-port=${port}/tcp`]);
        if (!r.ok)
            throw new Error(cockpit.format(_("The site was saved, but opening port $0 in the firewall failed: $1"),
                                           port, r.output.trim() || r.message));
    }
    if (options.openPorts && options.openPorts.length) {
        const r = await run(["firewall-cmd", "--reload"]);
        if (!r.ok)
            throw new Error(cockpit.format(_("The site was saved, but reloading the firewall failed: $0"),
                                           r.output.trim() || r.message));
    }
}

export async function saveRaw(entry: SiteEntry, content: string, features: RenderFeatures): Promise<void> {
    return saveContent(entry.name, content, { previous: entry, features });
}

async function saveContent(name: string, content: string, options: SaveOptions, root?: string): Promise<void> {
    const previous = options.previous;
    const enabled = previous ? previous.enabled : true;
    const path = previous ? previous.file : siteFile(name, true);

    if (options.createRoot && root)
        await helper(["ensure-root", root, name], "require");

    await writeFile(path, content);
    if (!enabled)
        return;

    try {
        await testAndReload();
    } catch (ex) {
        if (previous)
            await writeFile(path, previous.content);
        else
            await removeFile(path);
        throw ex;
    }
}

export async function setSiteEnabled(entry: SiteEntry, enabled: boolean): Promise<void> {
    if (entry.enabled === enabled)
        return;
    const target = siteFile(entry.name, enabled);
    await moveFile(entry.file, target);
    try {
        await testAndReload();
    } catch (ex) {
        await moveFile(target, entry.file);
        throw ex;
    }
}

export async function deleteSite(entry: SiteEntry): Promise<void> {
    await removeFile(entry.file);
    if (entry.meta?.basicAuth)
        await run(["rm", "-f", "--", htpasswdFile(entry.name)]);
    if (!entry.enabled)
        return;
    try {
        await testAndReload();
    } catch (ex) {
        await writeFile(entry.file, entry.content);
        throw ex;
    }
}

export async function createSelfSigned(name: string, domains: string[], days: number): Promise<{ cert: string, key: string }> {
    return helper(["selfsigned", name, String(days), ...domains], "require");
}

export async function deleteCert(cert: CertInfo): Promise<void> {
    if (cert.source === "selfsigned") {
        await helper(["delete-selfsigned", cert.name], "require");
        return;
    }
    const r = await run(["certbot", "delete", "--non-interactive", "--cert-name", cert.name]);
    if (!r.ok)
        throw failed(r, "certbot delete failed");
}

export type AcmeMethod = "nginx" | "webroot" | "standalone";

export interface LetsEncryptRequest {
    name: string;
    domains: string[];
    email: string;
    method: AcmeMethod;
    staging: boolean;
}

export async function requestLetsEncrypt(req: LetsEncryptRequest, acmeWebroot: string, onOutput: (chunk: string) => void): Promise<RunResult> {
    const args = ["certbot", "certonly", "--non-interactive", "--agree-tos",
        "--cert-name", req.name, "--deploy-hook", "systemctl reload nginx.service"];
    if (req.email)
        args.push("--email", req.email);
    else
        args.push("--register-unsafely-without-email");
    if (req.staging)
        args.push("--test-cert");
    if (req.method === "webroot") {
        await helper(["ensure-dir", acmeWebroot], "require");
        args.push("--webroot", "-w", acmeWebroot);
    } else {
        args.push("--" + req.method);
    }
    for (const d of req.domains)
        args.push("-d", d);
    return run(args, { environ: ["LC_ALL=C.UTF-8"] }, onOutput);
}

export function renewCert(name: string, dryRun: boolean, onOutput: (chunk: string) => void): Promise<RunResult> {
    const args = ["certbot", "renew", "--non-interactive", "--cert-name", name];
    args.push(dryRun ? "--dry-run" : "--force-renewal");
    return run(args, { environ: ["LC_ALL=C.UTF-8"] }, onOutput);
}

export function letsEncryptPaths(name: string): { cert: string, key: string } {
    return {
        cert: `/etc/letsencrypt/live/${name}/fullchain.pem`,
        key: `/etc/letsencrypt/live/${name}/privkey.pem`,
    };
}

/* Last LINES lines of a log file; errors (missing file, permissions) are returned as text. */
export async function readLog(path: string, lines = 200): Promise<string> {
    const r = await run(["tail", "-n", String(lines), "--", path], { superuser: "try" });
    return r.ok ? r.output : (r.output.trim() || r.message);
}

/* Last LINES lines of a log file that contain NEEDLE (fixed string). */
export async function readLogFiltered(path: string, needle: string, lines = 200): Promise<string> {
    const r = await run(["sh", "-c", 'grep -F -- "$1" "$2" | tail -n "$3"', "sh", needle, path, String(lines)],
                        { superuser: "try" });
    return r.ok || r.status === 1 ? r.output : (r.output.trim() || r.message);
}

/* Re-run the callback whenever something in DIR changes; returns a cleanup function. */
export function watchDirectory(dir: string, onChange: () => void): () => void {
    const channel = cockpit.channel({ payload: "fswatch1", path: dir, superuser: "try" });
    channel.addEventListener("message", onChange);
    return () => channel.close();
}

export interface ServiceProxy extends cockpit.EventSource<cockpit.EventMap> {
    exists: boolean | null;
    state: "starting" | "running" | "stopping" | "stopped" | "failed" | null | undefined;
    enabled: boolean | null | undefined;
}

export { CONF_DIR };
