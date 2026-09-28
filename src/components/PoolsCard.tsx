/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from 'react';
import { Alert, AlertActionCloseButton } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm
} from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { CheckCircleIcon } from "@patternfly/react-icons/dist/esm/icons/check-circle-icon.js";
import { TimesCircleIcon } from "@patternfly/react-icons/dist/esm/icons/times-circle-icon.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { useEvent, useObject } from "hooks";
import * as service from "service";
import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { ListingTable } from "cockpit-components-table.jsx";

import { ServiceProxy, SiteEntry, readLog } from "../lib/nginx";
import { PhpInfo, PoolEntry, poolFastcgi, poolListen, phpServiceAction, setPoolEnabled, deletePool, saveRawPool, readPoolLog } from "../lib/php";
import { POOL_HEADER_PREFIX } from "../lib/pools";
import { ConfirmDialog } from "./ConfirmDialog";
import { LogsDialog, LOG_LINES } from "./LogsDialog";
import { PoolDialog, pmLabel } from "./PoolDialog";
import { RawEditDialog } from "./RawEditDialog";

const _ = cockpit.gettext;

const ServiceStatus = ({ info, allowed }: { info: PhpInfo, allowed: boolean | null }) => {
    const proxy = useObject(() => service.proxy(info.service) as unknown as ServiceProxy, null, [info.service]);
    useEvent(proxy, "changed");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const act = async (verb: "start" | "stop" | "reload") => {
        setBusy(verb);
        setError(null);
        const r = await phpServiceAction(info, verb);
        if (!r.ok)
            setError(r.output.trim() || r.message);
        setBusy(null);
    };

    const running = proxy.state === "running";
    const disabled = !allowed || busy !== null;
    return (
        <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsCenter" }}>
            {running && <Label color="green" icon={<CheckCircleIcon />}>{_("Running")}</Label>}
            {!running && proxy.state === "failed" && <Label color="red" icon={<TimesCircleIcon />}>{_("Failed")}</Label>}
            {!running && proxy.state !== "failed" && <Label color="grey">{_("Not running")}</Label>}
            {running &&
                <Button variant="secondary" size="sm" onClick={() => act("reload")} isDisabled={disabled} isLoading={busy === "reload"}>
                    {_("Reload")}
                </Button>}
            {running &&
                <Button variant="secondary" size="sm" isDanger onClick={() => act("stop")} isDisabled={disabled} isLoading={busy === "stop"}>
                    {_("Stop")}
                </Button>}
            {!running &&
                <Button variant="secondary" size="sm" onClick={() => act("start")} isDisabled={disabled} isLoading={busy === "start"}>
                    {_("Start")}
                </Button>}
            {error &&
                <Alert isInline isPlain variant="danger" title={error} actionClose={<AlertActionCloseButton onClose={() => setError(null)} />} />}
        </Flex>
    );
};

export const PoolsCard = ({ info, pools, sites, allowed, refresh }: {
    info: PhpInfo | null,
    pools: PoolEntry[] | null,
    sites: SiteEntry[] | null,
    allowed: boolean | null,
    refresh: () => void,
}) => {
    const Dialogs = useDialogs();

    if (info && !info.available) {
        return (
            <Card className="ct-card" id="php-pools">
                <CardHeader>
                    <CardTitle component="h2">{_("PHP-FPM pools")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <EmptyStatePanel
title={_("PHP-FPM is not installed")}
                                     paragraph={_("Install the php-fpm package to run PHP sites; pools can then be managed here.")}
                                     headingLevel="h3"
                    />
                </CardBody>
            </Card>
        );
    }

    const usedBy = (entry: PoolEntry): SiteEntry[] => {
        if (!info)
            return [];
        const address = poolFastcgi(entry, info);
        return (sites || []).filter(s => s.meta?.type === "php" && s.meta.phpSocket === address);
    };

    const rowActions = (entry: PoolEntry) => {
        if (!info)
            return null;
        const users = usedBy(entry);
        const items = [];
        if (entry.meta)
            items.push(
                <DropdownItem
key="edit" onClick={() => Dialogs.show(
    <PoolDialog entry={entry} pools={pools || []} info={info} onDone={refresh} />)}
                >
                    {_("Edit")}
                </DropdownItem>);
        items.push(
            <DropdownItem
key="raw" onClick={() => Dialogs.show(
    <RawEditDialog
path={entry.file} content={entry.content} managed={!!entry.meta} validates={entry.enabled}
                               headerLine={POOL_HEADER_PREFIX} save={content => saveRawPool(entry, content, info)} onDone={refresh}
    />)}
            >
                {_("Edit configuration file")}
            </DropdownItem>,
            <DropdownItem
key="logs" onClick={() => Dialogs.show(
    <LogsDialog
title={cockpit.format(_("Logs of pool $0"), entry.section)} tabs={[
    {
        key: "errors",
        label: _("PHP errors"),
        description: cockpit.format(_("Last $0 lines about this pool in $1"), LOG_LINES, info.masterLog),
        read: () => readPoolLog(info, entry.section, LOG_LINES),
    },
    ...(entry.directives.slowlog || entry.meta?.slowlogTimeout
        ? [{
            key: "slow",
            label: _("Slow requests"),
            description: cockpit.format(_("Last $0 lines of $1"), LOG_LINES, slowlogPath(entry, info)),
            read: () => readLog(slowlogPath(entry, info), LOG_LINES),
        }]
        : []),
]}
    />)}
            >
                {_("View logs")}
            </DropdownItem>,
            <DropdownItem
key="toggle" onClick={() => Dialogs.show(
    <ConfirmDialog
title={entry.enabled ? cockpit.format(_("Disable pool $0?"), entry.name) : cockpit.format(_("Enable pool $0?"), entry.name)}
                               body={users.length > 0 && entry.enabled
                                   ? cockpit.format(_("Sites using this pool will stop working: $0"), users.map(u => u.name).join(", "))
                                   : _("The configuration file is renamed and php-fpm is reloaded.")}
                               confirmText={entry.enabled ? _("Disable") : _("Enable")} isDanger={entry.enabled && users.length > 0}
                               action={() => setPoolEnabled(entry, !entry.enabled, info)} onDone={refresh}
    />)}
            >
                {entry.enabled ? _("Disable") : _("Enable")}
            </DropdownItem>,
            <Divider key="d" />,
            <DropdownItem
key="delete" isDanger onClick={() => Dialogs.show(
    <ConfirmDialog
title={cockpit.format(_("Delete pool $0?"), entry.name)} isDanger
                               body={
                                   <Stack hasGutter>
                                       {users.length > 0 &&
                                           <Alert
isInline variant="warning"
                                                  title={cockpit.format(_("Used by: $0. Those sites will fail until they are given another pool."), users.map(u => u.name).join(", "))}
                                           />}
                                       <div>{cockpit.format(_("The file $0 and the pool's session directory are deleted. The system user and logs are kept."), entry.file)}</div>
                                   </Stack>
                               }
                               confirmText={_("Delete")} action={() => deletePool(entry, info)} onDone={refresh}
    />)}
            >
                {_("Delete")}
            </DropdownItem>);
        return <KebabDropdown dropdownItems={items} isDisabled={!allowed} toggleButtonId={`pool-${entry.name}-menu`} />;
    };

    const details = (entry: PoolEntry) => (
        <DescriptionList isHorizontal isCompact>
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Configuration file")}</DescriptionListTerm>
                <DescriptionListDescription><code>{entry.file}</code></DescriptionListDescription>
            </DescriptionListGroup>
            {info &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Use from nginx")}</DescriptionListTerm>
                    <DescriptionListDescription><code>fastcgi_pass {poolFastcgi(entry, info) || "-"};</code></DescriptionListDescription>
                </DescriptionListGroup>}
            {entry.meta &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("PHP limits")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {[
                            entry.meta.memoryLimit && `memory_limit ${entry.meta.memoryLimit}`,
                            entry.meta.uploadMaxFilesize && `upload_max_filesize ${entry.meta.uploadMaxFilesize}`,
                            entry.meta.postMaxSize && `post_max_size ${entry.meta.postMaxSize}`,
                            entry.meta.maxExecutionTime !== undefined && `max_execution_time ${entry.meta.maxExecutionTime}`,
                            entry.meta.openBasedir && `open_basedir ${entry.meta.openBasedir}`,
                        ].filter(Boolean).join(", ") || _("php.ini defaults")}
                    </DescriptionListDescription>
                </DescriptionListGroup>}
            {entry.meta && info &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Sessions")}</DescriptionListTerm>
                    <DescriptionListDescription><code>{info.sessionsDir}/{entry.name}</code></DescriptionListDescription>
                </DescriptionListGroup>}
            {!entry.meta &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Managed")}</DescriptionListTerm>
                    <DescriptionListDescription>{_("No. This pool was not created here; it can be edited as text, enabled, disabled or deleted.")}</DescriptionListDescription>
                </DescriptionListGroup>}
        </DescriptionList>
    );

    const rows = (pools || []).map(entry => {
        const pm = entry.meta ? entry.meta.pm : entry.directives.pm;
        const max = entry.meta ? entry.meta.maxChildren : entry.directives["pm.max_children"];
        return {
            props: { key: entry.name, "data-pool": entry.name },
            columns: [
                { title: entry.section },
                { title: info ? <code>{poolListen(entry, info) || "-"}</code> : "-" },
                { title: entry.meta ? entry.meta.user : (entry.directives.user || "-") },
                { title: pm ? `${pmLabel(pm as never).split(" (")[0]} · ${max || "?"}` : "-" },
                {
                    title: usedBy(entry).map(s => s.name)
                            .join(", ") || "-"
                },
                {
                    title: entry.enabled
                        ? <Label color="green">{_("Enabled")}</Label>
                        : <Label color="grey">{_("Disabled")}</Label>
                },
                { title: rowActions(entry), props: { className: "pf-v6-c-table__action" } },
            ],
            expandedContent: details(entry),
        };
    });

    const actions = (
        <Flex spaceItems={{ default: "spaceItemsMd" }} alignItems={{ default: "alignItemsCenter" }}>
            {info && <ServiceStatus info={info} allowed={allowed} />}
            <Button
variant="primary" id="add-pool" isDisabled={!allowed || !info}
                    onClick={() => info && Dialogs.show(<PoolDialog pools={pools || []} info={info} onDone={refresh} />)}
            >
                {_("Add pool")}
            </Button>
        </Flex>
    );

    return (
        <Card className="ct-card" id="php-pools">
            <CardHeader actions={{ actions }}>
                <CardTitle component="h2">
                    {info?.version ? cockpit.format(_("PHP-FPM pools (PHP $0)"), info.version) : _("PHP-FPM pools")}
                </CardTitle>
            </CardHeader>
            <CardBody className="contains-list">
                <ListingTable
aria-label={_("PHP-FPM pools")} variant="compact"
                              columns={[_("Pool"), _("Listen"), _("User"), _("Processes"), _("Used by"), _("Status"), ""]}
                              rows={rows}
                              loading={pools === null ? _("Loading pools...") : ""}
                              emptyCaption={_("No pools")}
                              emptyCaptionDetail={info ? cockpit.format(_("Files in $0 will appear here."), info.poolDir) : ""}
                />
            </CardBody>
        </Card>
    );
};

function slowlogPath(entry: PoolEntry, info: PhpInfo): string {
    return entry.directives.slowlog || `${info.logDir}/${entry.name}-slow.log`;
}
