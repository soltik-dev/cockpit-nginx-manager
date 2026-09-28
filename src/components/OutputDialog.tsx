/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useEffect, useRef, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { CodeBlock, CodeBlockCode } from "@patternfly/react-core/dist/esm/components/CodeBlock/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";

import { RunResult } from "../lib/nginx";

const _ = cockpit.gettext;

export const OutputDialog = ({ title, ok, summary, output }: {
    title: string,
    ok: boolean,
    summary?: string,
    output: string,
}) => {
    const Dialogs = useDialogs();
    return (
        <Modal position="top" variant="medium" isOpen onClose={Dialogs.close}>
            <ModalHeader title={title} titleIconVariant={ok ? "success" : "danger"} />
            <ModalBody>
                <Stack hasGutter>
                    <Alert
isInline variant={ok ? "success" : "danger"}
                           title={summary || (ok ? _("Command succeeded") : _("Command failed"))}
                    />
                    {output.trim() &&
                        <CodeBlock>
                            <CodeBlockCode className="nginx-manager-output">{output.trim()}</CodeBlockCode>
                        </CodeBlock>}
                </Stack>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={Dialogs.close}>{_("Close")}</Button>
            </ModalFooter>
        </Modal>
    );
};

/* Runs a long command, streaming its output into the dialog. */
export const CommandDialog = ({ title, command, onDone }: {
    title: string,
    command: (onOutput: (chunk: string) => void) => Promise<RunResult>,
    onDone?: () => void,
}) => {
    const Dialogs = useDialogs();
    const [output, setOutput] = useState("");
    const [result, setResult] = useState<RunResult | null>(null);
    const started = useRef(false);
    const outputRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (started.current)
            return;
        started.current = true;
        command(chunk => setOutput(prev => prev + chunk)).then(r => {
            setResult(r);
            if (onDone)
                onDone();
        });
    }, [command, onDone]);

    useEffect(() => {
        if (outputRef.current)
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }, [output]);

    const running = result === null;
    return (
        <Modal position="top" variant="medium" isOpen onClose={running ? undefined : Dialogs.close}>
            <ModalHeader title={title} {...running ? {} : { titleIconVariant: result.ok ? "success" as const : "danger" as const }} />
            <ModalBody>
                <Stack hasGutter>
                    {result && !result.ok &&
                        <Alert
isInline variant="danger"
                               title={result.message || cockpit.format(_("Command exited with status $0"), result.status)}
                        />}
                    {result && result.ok &&
                        <Alert isInline variant="success" title={_("Command succeeded")} />}
                    <CodeBlock>
                        <CodeBlockCode>
                            <div ref={outputRef} className="nginx-manager-output">{output || (running ? _("Running...") : "")}</div>
                        </CodeBlockCode>
                    </CodeBlock>
                </Stack>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={Dialogs.close} isDisabled={running} isLoading={running}>
                    {running ? _("Running...") : _("Close")}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
