/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { ModalError } from "cockpit-components-inline-notification.jsx";

import { errorMessage } from "../lib/nginx";

const _ = cockpit.gettext;

export const ConfirmDialog = ({ title, body, confirmText, isDanger, action, onDone }: {
    title: string,
    body: React.ReactNode,
    confirmText: string,
    isDanger?: boolean,
    action: () => Promise<void>,
    onDone?: () => void,
}) => {
    const Dialogs = useDialogs();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await action();
            Dialogs.close();
            if (onDone)
                onDone();
        } catch (ex) {
            setError(errorMessage(ex));
            setBusy(false);
        }
    };

    return (
        <Modal position="top" variant="small" isOpen onClose={Dialogs.close}>
            <ModalHeader title={title} {...isDanger ? { titleIconVariant: "warning" as const } : {}} />
            <ModalBody>
                <Stack hasGutter>
                    {error && <ModalError dialogError={_("Action failed")} dialogErrorDetail={error} />}
                    <div>{body}</div>
                </Stack>
            </ModalBody>
            <ModalFooter>
                <Button
variant={isDanger ? "danger" : "primary"} onClick={confirm}
                        isLoading={busy} isDisabled={busy}
                >
                    {confirmText}
                </Button>
                <Button variant="link" onClick={Dialogs.close} isDisabled={busy}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
