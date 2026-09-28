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
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { CheckCircleIcon } from "@patternfly/react-icons/dist/esm/icons/check-circle-icon.js";
import { ExclamationTriangleIcon } from "@patternfly/react-icons/dist/esm/icons/exclamation-triangle-icon.js";
import { TimesCircleIcon } from "@patternfly/react-icons/dist/esm/icons/times-circle-icon.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { useEvent, useObject } from "hooks";
import * as service from "service";

import { NginxInfo, ServiceProxy, serviceAction, testConfig } from "../lib/nginx";
import { OutputDialog } from "./OutputDialog";

const _ = cockpit.gettext;

type Verb = "start" | "stop" | "restart" | "reload" | "enable" | "disable" | "test";

const StateLabel = ({ state }: { state: string | null | undefined }) => {
    switch (state) {
    case "running":
        return <Label color="green" icon={<CheckCircleIcon />}>{_("Running")}</Label>;
    case "failed":
        return <Label color="red" icon={<TimesCircleIcon />}>{_("Failed")}</Label>;
    case "stopped":
        return <Label color="grey">{_("Not running")}</Label>;
    case "starting":
        return <Label color="blue">{_("Starting")}</Label>;
    case "stopping":
        return <Label color="blue">{_("Stopping")}</Label>;
    case undefined:
        return <Label color="orange" icon={<ExclamationTriangleIcon />}>{_("Not installed")}</Label>;
    default:
        return <Spinner size="md" />;
    }
};

export const ServiceCard = ({ info, allowed }: {
    info: NginxInfo | null,
    allowed: boolean | null,
}) => {
    const Dialogs = useDialogs();
    const proxy = useObject(() => service.proxy("nginx.service") as unknown as ServiceProxy, null, []);
    useEvent(proxy, "changed");
    const [busy, setBusy] = useState<Verb | null>(null);
    const [error, setError] = useState<string | null>(null);

    const act = async (verb: Exclude<Verb, "test">) => {
        setBusy(verb);
        setError(null);
        const r = await serviceAction(verb);
        if (!r.ok)
            setError(r.output.trim() || r.message || cockpit.format(_("systemctl $0 failed"), verb));
        setBusy(null);
    };

    const test = async () => {
        setBusy("test");
        const r = await testConfig();
        setBusy(null);
        const summary = r.ok ? _("The nginx configuration is valid") : _("The nginx configuration has errors");
        Dialogs.show(<OutputDialog title={_("Configuration test")} ok={r.ok} output={r.output} summary={summary} />);
    };

    const running = proxy.state === "running";
    const disabled = !allowed || busy !== null;

    const actions = (
        <Flex spaceItems={{ default: "spaceItemsSm" }}>
            <Button variant="secondary" onClick={test} isDisabled={disabled} isLoading={busy === "test"}>
                {_("Test configuration")}
            </Button>
            {running &&
                <Button variant="secondary" onClick={() => act("reload")} isDisabled={disabled} isLoading={busy === "reload"}>
                    {_("Reload")}
                </Button>}
            {running &&
                <Button variant="secondary" onClick={() => act("restart")} isDisabled={disabled} isLoading={busy === "restart"}>
                    {_("Restart")}
                </Button>}
            {running &&
                <Button variant="secondary" isDanger onClick={() => act("stop")} isDisabled={disabled} isLoading={busy === "stop"}>
                    {_("Stop")}
                </Button>}
            {!running &&
                <Button variant="primary" onClick={() => act("start")} isDisabled={disabled} isLoading={busy === "start"}>
                    {_("Start")}
                </Button>}
        </Flex>
    );

    return (
        <Card className="ct-card" id="nginx-service">
            <CardHeader actions={{ actions }}>
                <CardTitle component="h2">{_("nginx web server")}</CardTitle>
            </CardHeader>
            <CardBody>
                {error &&
                    <Alert
isInline variant="danger" title={_("Service action failed")}
                           actionClose={<AlertActionCloseButton onClose={() => setError(null)} />}
                    >
                        <pre className="nginx-manager-output">{error}</pre>
                    </Alert>}
                <DescriptionList isHorizontal isCompact>
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Status")}</DescriptionListTerm>
                        <DescriptionListDescription>
                            <Flex spaceItems={{ default: "spaceItemsMd" }} alignItems={{ default: "alignItemsCenter" }}>
                                <StateLabel state={proxy.exists === false ? undefined : proxy.state} />
                                <Button variant="link" isInline onClick={() => cockpit.jump("/system/services#/nginx.service")}>
                                    {_("Service details and logs")}
                                </Button>
                            </Flex>
                        </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Start on boot")}</DescriptionListTerm>
                        <DescriptionListDescription>
                            <Switch
id="nginx-enabled" aria-label={_("Start on boot")}
                                    isChecked={!!proxy.enabled} isDisabled={disabled || proxy.enabled == null}
                                    onChange={(_ev, checked) => act(checked ? "enable" : "disable")}
                            />
                        </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Version")}</DescriptionListTerm>
                        <DescriptionListDescription>{info?.version || _("Unknown")}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>{_("Sites directory")}</DescriptionListTerm>
                        <DescriptionListDescription><code>{info?.confDir || "/etc/nginx/conf.d"}</code></DescriptionListDescription>
                    </DescriptionListGroup>
                </DescriptionList>
            </CardBody>
        </Card>
    );
};
