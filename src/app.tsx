/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Page, PageSection } from '@patternfly/react-core/dist/esm/components/Page/index.js';
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import { WithDialogs } from "dialogs.jsx";
import { useEvent } from "hooks";
import { superuser } from "superuser";
import { FirewalldRequest } from "cockpit-components-firewalld-request.jsx";

import {
    CertList, NginxInfo, SiteEntry, CONF_DIR,
    listSites, listCerts, nginxInfo, watchDirectory, errorMessage,
} from "./lib/nginx";
import { PhpInfo, PoolEntry, phpInfo, listPools } from "./lib/php";
import { parseVersion } from "./lib/templates";
import { CertsCard } from "./components/CertsCard";
import { PoolsCard } from "./components/PoolsCard";
import { ServiceCard } from "./components/ServiceCard";
import { SitesCard } from "./components/SitesCard";

const _ = cockpit.gettext;

const WATCH_DIRS = [CONF_DIR, "/etc/letsencrypt/live", "/etc/nginx-manager/certs"];

export const Application = () => {
    useEvent(superuser, "changed");
    const allowed = superuser.allowed;

    const [info, setInfo] = useState<NginxInfo | null>(null);
    const [sites, setSites] = useState<SiteEntry[] | null>(null);
    const [certs, setCerts] = useState<CertList | null>(null);
    const [php, setPhp] = useState<PhpInfo | null>(null);
    const [pools, setPools] = useState<PoolEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(() => {
        listSites().then(setSites)
                .catch(ex => setError(errorMessage(ex)));
        listCerts().then(setCerts)
                .catch(ex => setError(errorMessage(ex)));
        listPools().then(setPools)
                .catch(ex => setError(errorMessage(ex)));
    }, []);

    /* (Re)load everything once the superuser state is known, and whenever it changes. */
    useEffect(() => {
        if (allowed === null)
            return;
        setError(null);
        nginxInfo().then(setInfo)
                .catch(ex => setError(errorMessage(ex)));
        phpInfo().then(setPhp)
                .catch(ex => setError(errorMessage(ex)));
        refresh();

        let timer: number | null = null;
        const changed = () => {
            if (timer !== null)
                window.clearTimeout(timer);
            timer = window.setTimeout(() => { timer = null; refresh() }, 500);
        };
        const dirs = php?.available ? [...WATCH_DIRS, php.poolDir] : WATCH_DIRS;
        const stops = dirs.map(dir => watchDirectory(dir, changed));
        return () => {
            if (timer !== null)
                window.clearTimeout(timer);
            stops.forEach(stop => stop());
        };
    }, [allowed, refresh, php?.available, php?.poolDir]);

    const features = useMemo(() => parseVersion(info?.version ?? null), [info]);

    return (
        <WithDialogs>
            <Page className="pf-m-no-sidebar">
                <PageSection hasBodyWrapper={false}>
                    <Stack hasGutter>
                        {allowed === false &&
                            <Alert
isInline variant="warning"
                                   title={_("Administrative access is required to change sites, certificates or the nginx service")}
                            >
                                {_("Use the \"Limited access\" button in the page header to switch to administrative access.")}
                            </Alert>}
                        {error &&
                            <Alert isInline variant="danger" title={_("Failed to read the nginx configuration")}>{error}</Alert>}
                        <FirewalldRequest service="http" pageSection={false} title={_("nginx serves HTTP on port 80, which is not allowed through the firewall")} />
                        <FirewalldRequest service="https" pageSection={false} title={_("nginx serves HTTPS on port 443, which is not allowed through the firewall")} />
                        <ServiceCard info={info} allowed={allowed} />
                        <SitesCard
sites={sites} certs={certs} info={info} php={php} pools={pools}
                                   features={features} allowed={allowed} refresh={refresh}
                        />
                        <CertsCard certs={certs} sites={sites} allowed={allowed} refresh={refresh} />
                        <PoolsCard info={php} pools={pools} sites={sites} allowed={allowed} refresh={refresh} />
                    </Stack>
                </PageSection>
            </Page>
        </WithDialogs>
    );
};
