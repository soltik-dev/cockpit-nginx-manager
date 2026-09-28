/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { ModalError } from "cockpit-components-inline-notification.jsx";

import { errorMessage } from "../lib/nginx";

const _ = cockpit.gettext;

export const RawEditDialog = ({ path, content: initial, managed, validates, headerLine, save, onDone }: {
    path: string,
    content: string,
    /* the file carries a nginx-manager header and is regenerated from the form */
    managed: boolean,
    /* the file is active, so it will be validated and the service reloaded on save */
    validates: boolean,
    /* how the header line starts, for the hint */
    headerLine: string,
    save: (content: string) => Promise<void>,
    onDone: () => void,
}) => {
    const Dialogs = useDialogs();
    const [content, setContent] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const doSave = async () => {
        setBusy(true);
        setError(null);
        try {
            await save(content);
            Dialogs.close();
            onDone();
        } catch (ex) {
            setError(errorMessage(ex));
            setBusy(false);
        }
    };

    return (
        <Modal position="top" variant="large" isOpen onClose={Dialogs.close}>
            <ModalHeader title={cockpit.format(_("Edit $0"), path)} />
            <ModalBody>
                <Stack hasGutter>
                    {error && <ModalError dialogError={_("The configuration was not applied")} dialogErrorDetail={error} />}
                    {managed &&
                        <Alert isInline variant="info" title={_("This file is managed from the form")}>
                            {cockpit.format(_("Manual changes are kept until it is saved from the form again, which regenerates the whole file. Remove the \"$0\" line to take full manual control."), headerLine.trim())}
                        </Alert>}
                    {validates &&
                        <Alert
isInline isPlain variant="info"
                               title={_("The configuration is validated and the service reloaded when saved. It is restored if validation fails.")}
                        />}
                    <TextArea
id="nginx-raw-editor" className="nginx-manager-code"
                              value={content} onChange={(_ev, v) => setContent(v)}
                              rows={24} resizeOrientation="vertical" spellCheck={false}
                              aria-label={_("Configuration file contents")}
                    />
                </Stack>
            </ModalBody>
            <ModalFooter>
                <Button
variant="primary" onClick={doSave} isLoading={busy}
                        isDisabled={busy || content === initial}
                >
                    {_("Save")}
                </Button>
                <Button variant="link" onClick={Dialogs.close} isDisabled={busy}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
