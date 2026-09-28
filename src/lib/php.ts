/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * PHP-FPM system access: detection, pool listing and pool changes with
 * validation and rollback, mirroring src/lib/nginx.ts for sites.
 */

import cockpit from "cockpit";

import { helper, run, writeFile, isActive, failed, removeFile, moveFile, readLogFiltered, RunResult } from "./nginx";
import { PoolConfig, renderPool, poolListenValue, fastcgiAddress } from "./pools";

const _ = cockpit.gettext;

export interface SystemUser {
    name: string;
    group: string;
}

export interface PhpInfo {
    available: boolean;
    version?: string | null;
    poolDir: string;
    mainConf: string;
    service: string;
    binary: string;
    runDir: string;
    masterLog: string;
    logDir: string;
    sessionsDir: string;
    webUser: string;
    users: SystemUser[];
}

export interface PoolEntry {
    file: string;
    name: string;
    section: string;
    enabled: boolean;
    content: string;
    meta: PoolConfig | null;
    directives: Record<string, string>;
    mtime: number;
    error: string | null;
}

export const phpInfo = () => helper<PhpInfo>(["php-info"]);
export const listPools = () => helper<PoolEntry[]>(["list-pools"]);

/* The "listen" value of a pool, managed or not. */
export function poolListen(entry: PoolEntry, info: PhpInfo): string | null {
    if (entry.meta)
        return poolListenValue(entry.meta, info.runDir);
    return entry.directives.listen || null;
}

/* What a site's fastcgi_pass must contain to use this pool. */
export function poolFastcgi(entry: PoolEntry, info: PhpInfo): string | null {
    const listen = poolListen(entry, info);
    return listen ? fastcgiAddress(listen) : null;
}

export function testPoolConfig(info: PhpInfo): Promise<RunResult> {
    return run([info.binary, "-t", "-y", info.mainConf]);
}

export function phpServiceAction(info: PhpInfo, verb: "start" | "stop" | "restart" | "reload"): Promise<RunResult> {
    return run(["systemctl", verb, info.service]);
}

async function testAndReload(info: PhpInfo): Promise<void> {
    const test = await testPoolConfig(info);
    if (!test.ok)
        throw failed(test, _("php-fpm rejected the configuration"));
    if (await isActive(info.service)) {
        const reload = await run(["systemctl", "reload", info.service]);
        if (!reload.ok)
            throw failed(reload, _("reloading php-fpm failed"));
    }
}

export interface PoolSaveOptions {
    previous?: PoolEntry | undefined;
    info: PhpInfo;
    /* create the pool's user as a system account if it does not exist */
    createUser?: boolean;
}

export async function savePool(pool: PoolConfig, options: PoolSaveOptions): Promise<void> {
    const info = options.info;
    if (options.createUser) {
        const r = await helper<{ created: boolean, group: string }>(["ensure-user", pool.user], "require");
        if (!pool.group)
            pool = { ...pool, group: r.group };
    }
    await helper(["prepare-pool", pool.name, pool.user, pool.group], "require");
    const content = renderPool(pool, info);
    await saveContent(pool.name, content, options);
}

export async function saveRawPool(entry: PoolEntry, content: string, info: PhpInfo): Promise<void> {
    await saveContent(entry.name, content, { previous: entry, info });
}

async function saveContent(name: string, content: string, options: PoolSaveOptions): Promise<void> {
    const previous = options.previous;
    const enabled = previous ? previous.enabled : true;
    const path = previous ? previous.file : `${options.info.poolDir}/${name}.conf`;

    await writeFile(path, content);
    if (!enabled)
        return;
    try {
        await testAndReload(options.info);
    } catch (ex) {
        if (previous)
            await writeFile(path, previous.content);
        else
            await removeFile(path);
        throw ex;
    }
}

export async function setPoolEnabled(entry: PoolEntry, enabled: boolean, info: PhpInfo): Promise<void> {
    if (entry.enabled === enabled)
        return;
    const target = `${info.poolDir}/${entry.name}.conf${enabled ? "" : ".disabled"}`;
    await moveFile(entry.file, target);
    try {
        await testAndReload(info);
    } catch (ex) {
        await moveFile(target, entry.file);
        throw ex;
    }
}

export async function deletePool(entry: PoolEntry, info: PhpInfo): Promise<void> {
    await removeFile(entry.file);
    if (entry.enabled) {
        try {
            await testAndReload(info);
        } catch (ex) {
            await writeFile(entry.file, entry.content);
            throw ex;
        }
    }
    if (entry.meta)
        await helper(["delete-pool-data", entry.name], "require");
}

/* Lines of the php-fpm master log that belong to this pool. */
export function readPoolLog(info: PhpInfo, section: string, lines = 200): Promise<string> {
    return readLogFiltered(info.masterLog, `[pool ${section}]`, lines);
}
