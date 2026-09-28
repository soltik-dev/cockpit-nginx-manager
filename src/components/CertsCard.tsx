/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm
} from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider/index.js";
import { DropdownItem } from "@patternfly/react-core/dist/esm/components/Dropdown/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import * as timeformat from 'timeformat';
import { useDialogs } from "dialogs.jsx";
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { ListingTable } from "cockpit-components-table.jsx";

import { CertInfo, CertList, SiteEntry, deleteCert, renewCert } from "../lib/nginx";
import { ConfirmDialog } from "./ConfirmDialog";
import { LetsEncryptDialog } from "./LetsEncryptDialog";
import { CommandDialog } from "./OutputDialog";
import { SelfSignedDialog } from "./SelfSignedDialog";
import { sourceLabel } from "./certs";

const _ = cockpit.gettext;

const ExpiryLabel = ({ cert }: { cert: CertInfo }) => {
    if (cert.error)
        return <Label color="red">{_("Unreadable")}</Label>;
    if (!cert.notAfter || cert.daysLeft === null)
        return <Label color="grey">{_("Unknown")}</Label>;
    const when = timeformat.dateShort(new Date(cert.notAfter));
    if (cert.daysLeft < 0)
        return <Label color="red">{cockpit.format(_("Expired $0"), when)}</Label>;
    if (cert.daysLeft <= 14)
        return <Label color="orange">{cockpit.format(_("$0 ($1 days left)"), when, cert.daysLeft)}</Label>;
    return <Label color="green" variant="outline">{when}</Label>;
};

export const CertsCard = ({ certs, sites, allowed, refresh }: {
    certs: CertList | null,
    sites: SiteEntry[] | null,
    allowed: boolean | null,
    refresh: () => void,
}) => {
    const Dialogs = useDialogs();
    const list = certs?.certs ?? [];

    const usedBy = (cert: CertInfo): SiteEntry[] =>
        (sites || []).filter(s => s.meta && s.meta.tls.mode === "cert" && s.meta.tls.cert === cert.cert);

    const rowActions = (cert: CertInfo) => {
        const users = usedBy(cert);
        const items = [];
        if (cert.source === "letsencrypt") {
            items.push(
                <DropdownItem
key="renew" onClick={() => Dialogs.show(
    <CommandDialog
title={cockpit.format(_("Renew $0"), cert.name)}
                                   command={out => renewCert(cert.name, false, out)} onDone={refresh}
    />)}
                >
                    {_("Renew now")}
                </DropdownItem>,
                <DropdownItem
key="dryrun" onClick={() => Dialogs.show(
    <CommandDialog
title={cockpit.format(_("Test renewal of $0"), cert.name)}
                                   command={out => renewCert(cert.name, true, out)}
    />)}
                >
                    {_("Test renewal (dry run)")}
                </DropdownItem>,
                <Divider key="d" />);
        }
        items.push(
            <DropdownItem
key="delete" isDanger onClick={() => Dialogs.show(
    <ConfirmDialog
title={cockpit.format(_("Delete certificate $0?"), cert.name)} isDanger
                               body={
                                   <Stack hasGutter>
                                       {users.length > 0 &&
                                           <Alert
isInline variant="warning"
                                                  title={cockpit.format(_("Used by: $0. Those sites will fail to load until they are given another certificate."),
                                                                        users.map(u => u.name).join(", "))}
                                           />}
                                       <div>
                                           {cert.source === "letsencrypt"
                                               ? _("The certificate is removed with \"certbot delete\" and will no longer be renewed.")
                                               : cockpit.format(_("The directory $0 will be deleted."), cert.cert.replace(/\/fullchain\.pem$/, ""))}
                                       </div>
                                   </Stack>
                               }
                               confirmText={_("Delete")} action={() => deleteCert(cert)} onDone={refresh}
    />)}
            >
                {_("Delete")}
            </DropdownItem>);
        return <KebabDropdown dropdownItems={items} isDisabled={!allowed} toggleButtonId={`cert-${cert.id}-menu`} />;
    };

    const details = (cert: CertInfo) => (
        <DescriptionList isHorizontal isCompact>
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Certificate file")}</DescriptionListTerm>
                <DescriptionListDescription><code>{cert.cert}</code></DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Private key file")}</DescriptionListTerm>
                <DescriptionListDescription><code>{cert.key}</code></DescriptionListDescription>
            </DescriptionListGroup>
            {cert.issuer &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Issuer")}</DescriptionListTerm>
                    <DescriptionListDescription>{cert.issuer}</DescriptionListDescription>
                </DescriptionListGroup>}
            {cert.notBefore &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Valid from")}</DescriptionListTerm>
                    <DescriptionListDescription>{timeformat.dateTime(new Date(cert.notBefore))}</DescriptionListDescription>
                </DescriptionListGroup>}
            {cert.notAfter &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Valid until")}</DescriptionListTerm>
                    <DescriptionListDescription>{timeformat.dateTime(new Date(cert.notAfter))}</DescriptionListDescription>
                </DescriptionListGroup>}
            {cert.error &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Error")}</DescriptionListTerm>
                    <DescriptionListDescription>{cert.error}</DescriptionListDescription>
                </DescriptionListGroup>}
        </DescriptionList>
    );

    const rows = list.map(cert => ({
        props: { key: cert.id, "data-cert": cert.id },
        columns: [
            { title: cert.name },
            { title: cert.sans.length ? cert.sans.join(", ") : (cert.cn || "-") },
            { title: sourceLabel(cert) },
            { title: <ExpiryLabel cert={cert} /> },
            {
                title: usedBy(cert).map(s => s.name)
                        .join(", ") || "-"
            },
            { title: rowActions(cert), props: { className: "pf-v6-c-table__action" } },
        ],
        expandedContent: details(cert),
    }));

    const leButton = (
        <Button
variant="primary" id="request-letsencrypt" isDisabled={!allowed || !certs?.certbot}
                onClick={() => certs && Dialogs.show(<LetsEncryptDialog acmeWebroot={certs.acmeWebroot} onDone={refresh} />)}
        >
            {_("Request Let's Encrypt certificate")}
        </Button>
    );

    const actions = (
        <Flex spaceItems={{ default: "spaceItemsSm" }}>
            {certs && !certs.certbot
                ? <Tooltip content={_("Install certbot to request Let's Encrypt certificates")}><span>{leButton}</span></Tooltip>
                : leButton}
            <Button
variant="secondary" id="create-selfsigned" isDisabled={!allowed || (certs !== null && !certs.openssl)}
                    onClick={() => Dialogs.show(<SelfSignedDialog existing={list} onDone={refresh} />)}
            >
                {_("Create self-signed certificate")}
            </Button>
        </Flex>
    );

    return (
        <Card className="ct-card" id="nginx-certificates">
            <CardHeader actions={{ actions }}>
                <CardTitle component="h2">{_("Certificates")}</CardTitle>
            </CardHeader>
            <CardBody className="contains-list">
                <Stack hasGutter>
                    {certs && certs.errors.length > 0 &&
                        <Alert isInline variant="warning" title={_("Some certificate directories could not be read")}>
                            {allowed === false
                                ? _("Turn on administrative access to see Let's Encrypt certificates.")
                                : certs.errors.join("; ")}
                        </Alert>}
                    <ListingTable
aria-label={_("Certificates")} variant="compact"
                                  columns={[_("Name"), _("Domains"), _("Type"), _("Expires"), _("Used by"), ""]}
                                  rows={rows}
                                  loading={certs === null ? _("Loading certificates...") : ""}
                                  emptyCaption={_("No certificates")}
                                  emptyCaptionDetail={_("Let's Encrypt certificates in /etc/letsencrypt/live and self-signed ones created here appear in this list.")}
                    />
                </Stack>
            </CardBody>
        </Card>
    );
};
