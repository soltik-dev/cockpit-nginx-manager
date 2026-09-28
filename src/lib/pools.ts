/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * PHP-FPM pool description and generator. Pools are stored as one ini file per
 * pool in the distribution's pool directory with a "; nginx-manager:" header.
 */

export type ProcessManager = "dynamic" | "ondemand" | "static";

export interface PoolListenSocket {
    type: "socket";
}

export interface PoolListenTcp {
    type: "tcp";
    address: string;
    port: number;
}

export interface PoolConfig {
    version: 1;
    name: string;
    user: string;
    group: string;
    listen: PoolListenSocket | PoolListenTcp;
    pm: ProcessManager;
    maxChildren: number;
    startServers?: number;
    minSpare?: number;
    maxSpare?: number;
    /* seconds, ondemand only */
    idleTimeout?: number;
    maxRequests?: number;
    memoryLimit?: string;
    uploadMaxFilesize?: string;
    postMaxSize?: string;
    maxExecutionTime?: number;
    openBasedir?: string;
    timezone?: string;
    displayErrors?: boolean;
    /* seconds; unset = no slow log */
    slowlogTimeout?: number;
    extra?: string;
}

export interface PoolRenderInfo {
    runDir: string;
    logDir: string;
    sessionsDir: string;
    webUser: string;
}

export const POOL_HEADER_PREFIX = "; nginx-manager: ";
export const POOL_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export const PHP_SIZE_RE = /^\d+[KMG]?$/i;
export const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
export const PATH_LIST_RE = /^[^\s;"']+$/;

export function poolSocketPath(name: string, runDir: string): string {
    return `${runDir}/${name}.sock`;
}

/* The value of the "listen" directive. */
export function poolListenValue(pool: PoolConfig, runDir: string): string {
    return pool.listen.type === "tcp"
        ? `${pool.listen.address}:${pool.listen.port}`
        : poolSocketPath(pool.name, runDir);
}

/* What nginx's fastcgi_pass needs for a php-fpm "listen" value. */
export function fastcgiAddress(listen: string): string {
    return listen.startsWith("/") ? "unix:" + listen : listen;
}

export function defaultPool(name = ""): PoolConfig {
    return {
        version: 1,
        name,
        user: "",
        group: "",
        listen: { type: "socket" },
        pm: "dynamic",
        maxChildren: 10,
        startServers: 2,
        minSpare: 1,
        maxSpare: 3,
        maxRequests: 500,
        memoryLimit: "256M",
        uploadMaxFilesize: "64M",
        postMaxSize: "64M",
    };
}

function indent(text: string): string {
    return text
            .split("\n")
            .map(line => line.trimEnd())
            .join("\n");
}

export function renderPool(pool: PoolConfig, info: PoolRenderInfo): string {
    const out: string[] = [];
    out.push("; Managed by Cockpit Nginx Manager (cockpit-nginx-manager).");
    out.push("; This file is regenerated whenever the pool is saved from Cockpit.");
    out.push("; Remove the following line to take manual control of this file.");
    out.push(POOL_HEADER_PREFIX + JSON.stringify(pool));
    out.push("");
    out.push(`[${pool.name}]`);
    out.push(`user = ${pool.user}`);
    out.push(`group = ${pool.group}`);
    out.push("");
    if (pool.listen.type === "tcp") {
        out.push(`listen = ${pool.listen.address}:${pool.listen.port}`);
        if (/^(127\.|::1$|localhost$)/.test(pool.listen.address))
            out.push(`listen.allowed_clients = ${pool.listen.address}`);
    } else {
        out.push(`listen = ${poolSocketPath(pool.name, info.runDir)}`);
        out.push(`listen.owner = ${info.webUser}`);
        out.push(`listen.group = ${info.webUser}`);
        out.push("listen.mode = 0660");
    }
    out.push("");
    out.push(`pm = ${pool.pm}`);
    out.push(`pm.max_children = ${pool.maxChildren}`);
    if (pool.pm === "dynamic") {
        out.push(`pm.start_servers = ${pool.startServers}`);
        out.push(`pm.min_spare_servers = ${pool.minSpare}`);
        out.push(`pm.max_spare_servers = ${pool.maxSpare}`);
    } else if (pool.pm === "ondemand") {
        out.push(`pm.process_idle_timeout = ${pool.idleTimeout || 10}s`);
    }
    if (pool.maxRequests)
        out.push(`pm.max_requests = ${pool.maxRequests}`);
    out.push("");
    out.push("; PHP errors go to the php-fpm master log, prefixed with the pool name");
    out.push("catch_workers_output = yes");
    out.push("php_admin_flag[log_errors] = on");
    out.push(`php_admin_flag[display_errors] = ${pool.displayErrors ? "on" : "off"}`);
    if (pool.slowlogTimeout) {
        out.push(`slowlog = ${info.logDir}/${pool.name}-slow.log`);
        out.push(`request_slowlog_timeout = ${pool.slowlogTimeout}s`);
    }
    out.push("");
    out.push("; PHP settings for this pool");
    if (pool.memoryLimit)
        out.push(`php_admin_value[memory_limit] = ${pool.memoryLimit}`);
    if (pool.uploadMaxFilesize)
        out.push(`php_admin_value[upload_max_filesize] = ${pool.uploadMaxFilesize}`);
    if (pool.postMaxSize)
        out.push(`php_admin_value[post_max_size] = ${pool.postMaxSize}`);
    if (pool.maxExecutionTime !== undefined)
        out.push(`php_admin_value[max_execution_time] = ${pool.maxExecutionTime}`);
    if (pool.openBasedir)
        out.push(`php_admin_value[open_basedir] = ${pool.openBasedir}`);
    if (pool.timezone)
        out.push(`php_admin_value[date.timezone] = ${pool.timezone}`);
    out.push("php_value[session.save_handler] = files");
    out.push(`php_value[session.save_path] = ${info.sessionsDir}/${pool.name}`);
    if (pool.extra && pool.extra.trim()) {
        out.push("");
        out.push("; Custom directives");
        out.push(indent(pool.extra.trim()));
    }
    out.push("");
    return out.join("\n");
}
