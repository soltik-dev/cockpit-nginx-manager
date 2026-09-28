/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm
} from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { ExternalLinkAltIcon } from "@patternfly/react-icons/dist/esm/icons/external-link-alt-icon.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { ListingTable } from "cockpit-components-table.jsx";

import { CertList, NginxInfo, SiteEntry, setSiteEnabled, deleteSite, saveSite, saveRaw } from "../lib/nginx";
import { PhpInfo, PoolEntry } from "../lib/php";
import { RenderFeatures, HEADER_PREFIX } from "../lib/templates";
import { ConfirmDialog } from "./ConfirmDialog";
import { LetsEncryptDialog } from "./LetsEncryptDialog";
import { LogsDialog, siteLogTabs } from "./LogsDialog";
import { RawEditDialog } from "./RawEditDialog";
import { SelfSignedDialog, CertPaths } from "./SelfSignedDialog";
import { SiteDialog, typeLabel } from "./SiteDialog";
import { certLabel } from "./certs";

const _ = cockpit.gettext;

const siteUrl = (entry: SiteEntry): string | null => {
    const domains = entry.meta ? entry.meta.domains : entry.serverNames;
    const domain = domains.find(d => d !== "_" && !d.startsWith("*") && !d.startsWith("~"));
    if (!domain)
        return null;
    const https = entry.meta ? entry.meta.tls.mode === "cert" : /ssl_certificate/.test(entry.content);
    const port = entry.meta ? (https ? entry.meta.httpsPort || 443 : entry.meta.httpPort || 80) : (https ? 443 : 80);
    const standard = port === (https ? 443 : 80);
    return `${https ? "https" : "http"}://${domain}${standard ? "" : ":" + port}/`;
};

export const SitesCard = ({ sites, certs, info, php, pools, features, allowed, refresh }: {
    sites: SiteEntry[] | null,
    certs: CertList | null,
    info: NginxInfo | null,
    php: PhpInfo | null,
    pools: PoolEntry[] | null,
    features: RenderFeatures,
    allowed: boolean | null,
    refresh: () => void,
}) => {
    const Dialogs = useDialogs();
    const certList = certs?.certs ?? [];

    const attachCert = (entry: SiteEntry) => async (paths: CertPaths) => {
        if (!entry.meta)
            return;
        await saveSite({ ...entry.meta, tls: { mode: "cert", cert: paths.cert, key: paths.key, redirect: true, hsts: false } },
                       { previous: entry, features });
    };

    const rowActions = (entry: SiteEntry) => {
        const domains = entry.meta ? entry.meta.domains : entry.serverNames;
        const items = [];
        if (entry.meta)
            items.push(
                <DropdownItem
key="edit" onClick={() => Dialogs.show(
    <SiteDialog
entry={entry} sites={sites || []} certs={certList} info={info} php={php} pools={pools || []}
                                features={features} onDone={refresh}
    />)}
                >
                    {_("Edit")}
                </DropdownItem>);
        items.push(
            <DropdownItem
key="raw" onClick={() => Dialogs.show(
    <RawEditDialog
path={entry.file} content={entry.content} managed={!!entry.meta} validates={entry.enabled}
                               headerLine={HEADER_PREFIX} save={content => saveRaw(entry, content, features)} onDone={refresh}
    />)}
            >
                {_("Edit configuration file")}
            </DropdownItem>,
            <DropdownItem
key="logs" onClick={() => Dialogs.show(
    <LogsDialog title={cockpit.format(_("Logs of $0"), entry.name)} tabs={siteLogTabs(entry)} />)}
            >
                {_("View logs")}
            </DropdownItem>,
            <DropdownItem
key="toggle" onClick={() => Dialogs.show(
    <ConfirmDialog
title={entry.enabled ? cockpit.format(_("Disable $0?"), entry.name) : cockpit.format(_("Enable $0?"), entry.name)}
                               body={entry.enabled
                                   ? _("The configuration file is renamed so that nginx ignores it, and nginx is reloaded.")
                                   : _("The configuration file is renamed back, validated and nginx is reloaded.")}
                               confirmText={entry.enabled ? _("Disable") : _("Enable")}
                               action={() => setSiteEnabled(entry, !entry.enabled)} onDone={refresh}
    />)}
            >
                {entry.enabled ? _("Disable") : _("Enable")}
            </DropdownItem>);
        if (entry.hasServer && domains.length > 0) {
            items.push(<Divider key="d1" />);
            if (certs?.certbot)
                items.push(
                    <DropdownItem
key="le" onClick={() => Dialogs.show(
    <LetsEncryptDialog
domains={domains.filter(d => d !== "_")} acmeWebroot={certs.acmeWebroot}
                                           siteName={entry.meta ? entry.name : undefined}
                                           onIssued={entry.meta ? attachCert(entry) : undefined} onDone={refresh}
    />)}
                    >
                        {_("Request Let's Encrypt certificate")}
                    </DropdownItem>);
            items.push(
                <DropdownItem
key="self" onClick={() => Dialogs.show(
    <SelfSignedDialog
domains={domains.filter(d => d !== "_")} existing={certList}
                                      siteName={entry.meta ? entry.name : undefined}
                                      onIssued={entry.meta ? attachCert(entry) : undefined} onDone={refresh}
    />)}
                >
                    {_("Create self-signed certificate")}
                </DropdownItem>);
        }
        items.push(
            <Divider key="d2" />,
            <DropdownItem
key="delete" isDanger onClick={() => Dialogs.show(
    <ConfirmDialog
title={cockpit.format(_("Delete $0?"), entry.name)} isDanger
                               body={cockpit.format(_("The file $0 will be deleted. Website files, logs and certificates are kept."), entry.file)}
                               confirmText={_("Delete")} action={() => deleteSite(entry)} onDone={refresh}
    />)}
            >
                {_("Delete")}
            </DropdownItem>);
        return <KebabDropdown dropdownItems={items} isDisabled={!allowed} toggleButtonId={`site-${entry.name}-menu`} />;
    };

    const tlsCell = (entry: SiteEntry) => {
        if (entry.meta) {
            if (entry.meta.tls.mode !== "cert")
                return <Label color="grey" variant="outline">{_("HTTP only")}</Label>;
            const tls = entry.meta.tls;
            const cert = certList.find(c => c.cert === tls.cert);
            if (cert)
                return <Label color={cert.daysLeft !== null && cert.daysLeft < 0 ? "red" : "green"}>{certLabel(cert)}</Label>;
            return <Label color="blue">{_("Custom certificate")}</Label>;
        }
        return /ssl_certificate/.test(entry.content) ? _("Yes") : "-";
    };

    const details = (entry: SiteEntry) => {
        const url = siteUrl(entry);
        return (
            <DescriptionList isHorizontal isCompact>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Configuration file")}</DescriptionListTerm>
                    <DescriptionListDescription><code>{entry.file}</code></DescriptionListDescription>
                </DescriptionListGroup>
                {entry.meta?.root &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Document root")}</DescriptionListTerm>
                        <DescriptionListDescription><code>{entry.meta.root}</code></DescriptionListDescription>
                    </DescriptionListGroup>}
                {entry.meta?.redirectTo &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Redirects to")}</DescriptionListTerm>
                        <DescriptionListDescription>
                            <code>{entry.meta.redirectTo}</code>
                            {entry.meta.redirectTemporary ? " (302)" : " (301)"}
                        </DescriptionListDescription>
                    </DescriptionListGroup>}
                {entry.meta && (entry.meta.httpPort || entry.meta.httpsPort || entry.meta.listenAddress || entry.meta.ipv6 === false) &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Listening on")}</DescriptionListTerm>
                        <DescriptionListDescription>
                            {(entry.meta.listenAddress || (entry.meta.ipv6 === false ? _("IPv4 only") : _("all addresses"))) +
                                ", " + cockpit.format(_("HTTP port $0"), entry.meta.httpPort || 80) +
                                (entry.meta.tls.mode === "cert" ? ", " + cockpit.format(_("HTTPS port $0"), entry.meta.httpsPort || 443) : "")}
                        </DescriptionListDescription>
                    </DescriptionListGroup>}
                {entry.meta?.canonical && entry.meta.domains.length > 1 &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Canonical host")}</DescriptionListTerm>
                        <DescriptionListDescription>{entry.meta.canonical}</DescriptionListDescription>
                    </DescriptionListGroup>}
                {entry.meta?.allowFrom && entry.meta.allowFrom.length > 0 &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Allowed from")}</DescriptionListTerm>
                        <DescriptionListDescription>{entry.meta.allowFrom.join(", ")}</DescriptionListDescription>
                    </DescriptionListGroup>}
                {entry.meta?.basicAuth &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Password protected")}</DescriptionListTerm>
                        <DescriptionListDescription>
                            {cockpit.format(_("Users: $0"), entry.meta.basicAuth.users.join(", "))}
                        </DescriptionListDescription>
                    </DescriptionListGroup>}
                {entry.meta?.upstream &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Upstream")}</DescriptionListTerm>
                        <DescriptionListDescription><code>{entry.meta.upstream}</code></DescriptionListDescription>
                    </DescriptionListGroup>}
                {entry.meta?.phpSocket &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("PHP-FPM socket")}</DescriptionListTerm>
                        <DescriptionListDescription><code>{entry.meta.phpSocket}</code></DescriptionListDescription>
                    </DescriptionListGroup>}
                {entry.meta?.tls.mode === "cert" &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Certificate")}</DescriptionListTerm>
                        <DescriptionListDescription>
                            <code>{entry.meta.tls.cert}</code>
                            {entry.meta.tls.redirect ? " · " + _("HTTP redirects to HTTPS") : ""}
                            {entry.meta.tls.hsts ? " · HSTS" : ""}
                        </DescriptionListDescription>
                    </DescriptionListGroup>}
                {entry.meta &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Logs")}</DescriptionListTerm>
                        <DescriptionListDescription>
                            {entry.meta.disableAccessLog
                                ? <>{_("access log disabled")}, </>
                                : <><code>/var/log/nginx/{entry.name}.access.log</code>, </>}
                            <code>/var/log/nginx/{entry.name}.error.log</code>
                        </DescriptionListDescription>
                    </DescriptionListGroup>}
                {!entry.meta &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Managed")}</DescriptionListTerm>
                        <DescriptionListDescription>
                            {_("No. This file was not created here; it can be edited as text, enabled, disabled or deleted.")}
                        </DescriptionListDescription>
                    </DescriptionListGroup>}
                {url &&
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("URL")}</DescriptionListTerm>
                        <DescriptionListDescription>
                            <a href={url} target="_blank" rel="noopener noreferrer">{url} <ExternalLinkAltIcon /></a>
                        </DescriptionListDescription>
                    </DescriptionListGroup>}
            </DescriptionList>
        );
    };

    const rows = (sites || []).map(entry => {
        const domains = entry.meta ? entry.meta.domains : entry.serverNames;
        return {
            props: { key: entry.name, "data-site": entry.name },
            columns: [
                { title: entry.name },
                { title: domains.length ? domains.join(", ") : "-" },
                { title: entry.meta ? typeLabel(entry.meta.type) : (entry.hasServer ? _("Unmanaged") : _("Snippet")) },
                { title: tlsCell(entry) },
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

    const addButton = (
        <Button
variant="primary" id="add-site" isDisabled={!allowed}
                onClick={() => Dialogs.show(
                    <SiteDialog
sites={sites || []} certs={certList} info={info} php={php} pools={pools || []}
                                features={features} onDone={refresh}
                    />)}
        >
            {_("Add site")}
        </Button>
    );

    return (
        <Card className="ct-card" id="nginx-sites">
            <CardHeader actions={{ actions: addButton }}>
                <CardTitle component="h2">{_("Sites")}</CardTitle>
            </CardHeader>
            <CardBody className="contains-list">
                <ListingTable
aria-label={_("Sites")} variant="compact"
                              columns={[_("Name"), _("Domains"), _("Type"), _("TLS"), _("Status"), ""]}
                              rows={rows}
                              loading={sites === null ? _("Loading sites...") : ""}
                              emptyCaption={_("No sites configured")}
                              emptyCaptionDetail={cockpit.format(_("Files in $0 will appear here. Add a site to get started."), info?.confDir || "/etc/nginx/conf.d")}
                />
            </CardBody>
        </Card>
    );
};
