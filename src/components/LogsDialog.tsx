/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { CodeBlock, CodeBlockCode } from "@patternfly/react-core/dist/esm/components/CodeBlock/index.js";
import { Content } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Tab, Tabs, TabTitleText } from "@patternfly/react-core/dist/esm/components/Tabs/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";

import { SiteEntry, readLog } from "../lib/nginx";
import { logFiles } from "../lib/templates";

const _ = cockpit.gettext;

export const LOG_LINES = 200;

export interface LogTab {
    key: string;
    label: string;
    /* shown above the output, e.g. which file is being read */
    description: string;
    /* undefined when there is nothing to read (e.g. access log disabled) */
    read?: (() => Promise<string>) | undefined;
}

export const LogsDialog = ({ title, tabs }: { title: string, tabs: LogTab[] }) => {
    const Dialogs = useDialogs();
    const [active, setActive] = useState<string | number>(tabs.find(t => t.read)?.key ?? tabs[0]?.key ?? "");
    const [texts, setTexts] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        const results = await Promise.all(tabs.map(async t => [t.key, t.read ? await t.read() : ""] as const));
        setTexts(Object.fromEntries(results));
        setLoading(false);
    }, [tabs]);

    useEffect(() => { load() }, [load]);

    return (
        <Modal position="top" variant="large" isOpen onClose={Dialogs.close}>
            <ModalHeader title={title} />
            <ModalBody>
                <Tabs activeKey={active} onSelect={(_ev, key) => setActive(key)} mountOnEnter>
                    {tabs.map(t =>
                        <Tab key={t.key} eventKey={t.key} title={<TabTitleText>{t.label}</TabTitleText>}>
                            <Content component="p">{t.description}</Content>
                            {t.read &&
                                <CodeBlock>
                                    <CodeBlockCode>
                                        <div className="nginx-manager-output nginx-manager-log">
                                            {texts[t.key] === undefined ? _("Loading...") : (texts[t.key].trim() || _("(empty)"))}
                                        </div>
                                    </CodeBlockCode>
                                </CodeBlock>}
                        </Tab>)}
                </Tabs>
            </ModalBody>
            <ModalFooter>
                <Button variant="secondary" onClick={load} isLoading={loading} isDisabled={loading}>{_("Refresh")}</Button>
                <Button variant="link" onClick={Dialogs.close}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
};

export function siteLogTabs(entry: SiteEntry): LogTab[] {
    const files = logFiles(entry.name, entry.meta, entry.content);
    return [
        {
            key: "access",
            label: _("Access log"),
            description: files.access
                ? cockpit.format(_("Last $0 lines of $1"), LOG_LINES, files.access)
                : _("The access log is disabled for this site."),
            read: files.access ? () => readLog(files.access as string, LOG_LINES) : undefined,
        },
        {
            key: "error",
            label: _("Error log"),
            description: cockpit.format(_("Last $0 lines of $1"), LOG_LINES, files.error),
            read: () => readLog(files.error, LOG_LINES),
        },
    ];
}
