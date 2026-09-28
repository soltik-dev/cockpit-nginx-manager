/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { FormHelper } from "cockpit-components-form-helper.jsx";
import { ModalError } from "cockpit-components-inline-notification.jsx";

import { CertInfo, createSelfSigned, errorMessage } from "../lib/nginx";
import { NAME_RE, DOMAIN_RE, nameFromDomain, parseDomains } from "../lib/templates";

const _ = cockpit.gettext;

export interface CertPaths {
    cert: string;
    key: string;
}

export const SelfSignedDialog = ({ domains, existing, siteName, onIssued, onDone }: {
    domains?: string[] | undefined,
    existing: CertInfo[],
    siteName?: string | undefined,
    onIssued?: ((paths: CertPaths) => Promise<void>) | undefined,
    onDone: () => void,
}) => {
    const Dialogs = useDialogs();
    const initialDomains = (domains || []).join(" ");
    const [name, setName] = useState(domains && domains.length ? nameFromDomain(domains[0]) : "");
    const [nameTouched, setNameTouched] = useState(false);
    const [domainsText, setDomainsText] = useState(initialDomains);
    const [days, setDays] = useState("3650");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errors, setErrors] = useState<Record<string, string>>({});

    const onDomainsChange = (value: string) => {
        setDomainsText(value);
        if (!nameTouched) {
            const list = parseDomains(value);
            setName(list.length ? nameFromDomain(list[0]) : "");
        }
    };

    const validate = () => {
        const errs: Record<string, string> = {};
        const list = parseDomains(domainsText);
        if (!NAME_RE.test(name))
            errs.name = _("Use only letters, digits, dots, dashes and underscores");
        else if (existing.some(c => c.source === "selfsigned" && c.name === name))
            errs.name = _("A self-signed certificate with this name already exists");
        if (list.length === 0)
            errs.domains = _("At least one domain is required");
        else if (list.some(d => !DOMAIN_RE.test(d) || d === "_"))
            errs.domains = _("Invalid domain name");
        const n = Number(days);
        if (!Number.isInteger(n) || n < 1 || n > 36500)
            errs.days = _("Enter a number of days between 1 and 36500");
        setErrors(errs);
        return Object.keys(errs).length === 0 ? list : null;
    };

    const create = async () => {
        const list = validate();
        if (!list)
            return;
        setBusy(true);
        setError(null);
        try {
            const paths = await createSelfSigned(name, list, Number(days));
            if (onIssued)
                await onIssued(paths);
            Dialogs.close();
            onDone();
        } catch (ex) {
            setError(errorMessage(ex));
            setBusy(false);
        }
    };

    return (
        <Modal position="top" variant="small" isOpen onClose={Dialogs.close}>
            <ModalHeader title={_("Create self-signed certificate")} />
            <ModalBody>
                <Stack hasGutter>
                    {error && <ModalError dialogError={_("Creating the certificate failed")} dialogErrorDetail={error} />}
                    <Alert
isInline isPlain variant="info"
                           title={_("Browsers will warn about self-signed certificates. Use them for internal or test hosts only.")}
                    />
                    <Form isHorizontal onSubmit={ev => { ev.preventDefault(); create() }}>
                        <FormGroup label={_("Domains")} fieldId="selfsigned-domains" isRequired>
                            <TextInput
id="selfsigned-domains" value={domainsText}
                                       onChange={(_ev, v) => onDomainsChange(v)}
                                       validated={errors.domains ? "error" : "default"}
                                       placeholder="example.lan www.example.lan"
                            />
                            <FormHelper
fieldId="selfsigned-domains" helperTextInvalid={errors.domains}
                                        helperText={_("Separate several names or IP addresses with spaces.")}
                            />
                        </FormGroup>
                        <FormGroup label={_("Name")} fieldId="selfsigned-name" isRequired>
                            <TextInput
id="selfsigned-name" value={name}
                                       onChange={(_ev, v) => { setName(v); setNameTouched(true) }}
                                       validated={errors.name ? "error" : "default"}
                            />
                            <FormHelper
fieldId="selfsigned-name" helperTextInvalid={errors.name}
                                        helperText={_("Stored in /etc/nginx-manager/certs/<name>/")}
                            />
                        </FormGroup>
                        <FormGroup label={_("Valid for (days)")} fieldId="selfsigned-days" isRequired>
                            <TextInput
id="selfsigned-days" type="number" value={days}
                                       onChange={(_ev, v) => setDays(v)}
                                       validated={errors.days ? "error" : "default"}
                            />
                            <FormHelper fieldId="selfsigned-days" helperTextInvalid={errors.days} />
                        </FormGroup>
                    </Form>
                    {siteName && onIssued &&
                        <Alert
isInline isPlain variant="info"
                               title={cockpit.format(_("The site $0 will be updated to use this certificate."), siteName)}
                        />}
                </Stack>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={create} isLoading={busy} isDisabled={busy}>
                    {_("Create")}
                </Button>
                <Button variant="link" onClick={Dialogs.close} isDisabled={busy}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
