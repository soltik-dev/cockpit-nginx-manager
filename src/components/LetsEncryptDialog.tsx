/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useEffect, useRef, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { CodeBlock, CodeBlockCode } from "@patternfly/react-core/dist/esm/components/CodeBlock/index.js";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { FormHelper } from "cockpit-components-form-helper.jsx";
import { ModalError } from "cockpit-components-inline-notification.jsx";

import { AcmeMethod, requestLetsEncrypt, letsEncryptPaths, errorMessage } from "../lib/nginx";
import { NAME_RE, DOMAIN_RE, nameFromDomain, parseDomains } from "../lib/templates";
import { CertPaths } from "./SelfSignedDialog";

const _ = cockpit.gettext;

const EMAIL_KEY = "nginx-manager.letsencrypt-email";

function loadEmail(): string {
    try {
        return cockpit.localStorage.getItem(EMAIL_KEY) || "";
    } catch {
        return "";
    }
}

function storeEmail(email: string) {
    try {
        cockpit.localStorage.setItem(EMAIL_KEY, email);
    } catch {
        /* ignore */
    }
}

type Phase = "form" | "running" | "done" | "failed";

export const LetsEncryptDialog = ({ domains, acmeWebroot, siteName, onIssued, onDone }: {
    domains?: string[] | undefined,
    acmeWebroot: string,
    siteName?: string | undefined,
    onIssued?: ((paths: CertPaths) => Promise<void>) | undefined,
    onDone: () => void,
}) => {
    const Dialogs = useDialogs();
    const [name, setName] = useState(domains && domains.length ? nameFromDomain(domains[0]) : "");
    const [nameTouched, setNameTouched] = useState(false);
    const [domainsText, setDomainsText] = useState((domains || []).join(" "));
    const [email, setEmail] = useState(loadEmail);
    const [method, setMethod] = useState<AcmeMethod>("nginx");
    const [staging, setStaging] = useState(false);
    const [agree, setAgree] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [phase, setPhase] = useState<Phase>("form");
    const [output, setOutput] = useState("");
    const [error, setError] = useState<string | null>(null);
    const outputRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (outputRef.current)
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }, [output]);

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
        if (list.length === 0)
            errs.domains = _("At least one domain is required");
        else if (list.some(d => !DOMAIN_RE.test(d) || d === "_"))
            errs.domains = _("Invalid domain name");
        else if (list.some(d => d.startsWith("*.")))
            errs.domains = _("Wildcard certificates need DNS validation, which is not supported here");
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            errs.email = _("Invalid email address");
        if (!agree)
            errs.agree = _("You must agree to the subscriber agreement");
        setErrors(errs);
        return Object.keys(errs).length === 0 ? list : null;
    };

    const request = async () => {
        const list = validate();
        if (!list)
            return;
        storeEmail(email);
        setPhase("running");
        setOutput("");
        setError(null);
        try {
            const result = await requestLetsEncrypt({ name, domains: list, email, method, staging }, acmeWebroot,
                                                    chunk => setOutput(prev => prev + chunk));
            if (!result.ok) {
                setError(result.message || cockpit.format(_("certbot exited with status $0"), result.status));
                setPhase("failed");
                return;
            }
            if (onIssued) {
                setOutput(prev => prev + "\n" + cockpit.format(_("Updating site $0 to use the new certificate..."), siteName) + "\n");
                await onIssued(letsEncryptPaths(name));
            }
            setPhase("done");
            onDone();
        } catch (ex) {
            setError(errorMessage(ex));
            setPhase("failed");
            onDone();
        }
    };

    const running = phase === "running";
    const finished = phase === "done" || phase === "failed";

    return (
        <Modal position="top" variant="medium" isOpen onClose={running ? undefined : Dialogs.close}>
            <ModalHeader title={_("Request Let's Encrypt certificate")} />
            <ModalBody>
                <Stack hasGutter>
                    {phase === "failed" && error &&
                        <ModalError dialogError={_("The certificate was not issued")} dialogErrorDetail={error} />}
                    {phase === "done" &&
                        <Alert isInline variant="success" title={_("Certificate issued")}>
                            {_("Renewal is handled automatically by certbot's systemd timer; nginx is reloaded after each renewal.")}
                        </Alert>}
                    {phase === "form" &&
                        <Alert
isInline isPlain variant="info"
                               title={_("The domains must resolve to this server and port 80 must be reachable from the Internet.")}
                        />}
                    {(phase === "form") &&
                        <Form isHorizontal onSubmit={ev => { ev.preventDefault(); request() }}>
                            <FormGroup label={_("Domains")} fieldId="le-domains" isRequired>
                                <TextInput
id="le-domains" value={domainsText}
                                           onChange={(_ev, v) => onDomainsChange(v)}
                                           validated={errors.domains ? "error" : "default"}
                                           placeholder="example.com www.example.com"
                                />
                                <FormHelper
fieldId="le-domains" helperTextInvalid={errors.domains}
                                            helperText={_("Separate several names with spaces. All of them go into one certificate.")}
                                />
                            </FormGroup>
                            <FormGroup label={_("Certificate name")} fieldId="le-name" isRequired>
                                <TextInput
id="le-name" value={name}
                                           onChange={(_ev, v) => { setName(v); setNameTouched(true) }}
                                           validated={errors.name ? "error" : "default"}
                                />
                                <FormHelper
fieldId="le-name" helperTextInvalid={errors.name}
                                            helperText={_("Stored in /etc/letsencrypt/live/<name>/. Reusing a name replaces that certificate.")}
                                />
                            </FormGroup>
                            <FormGroup label={_("Email")} fieldId="le-email">
                                <TextInput
id="le-email" type="email" value={email}
                                           onChange={(_ev, v) => setEmail(v)}
                                           validated={errors.email ? "error" : "default"}
                                />
                                <FormHelper
fieldId="le-email" helperTextInvalid={errors.email}
                                            helperText={_("Used by Let's Encrypt for expiry warnings. Leave empty to register without an address.")}
                                />
                            </FormGroup>
                            <FormGroup label={_("Validation")} fieldId="le-method">
                                <FormSelect
id="le-method" value={method}
                                            onChange={(_ev, v) => setMethod(v as AcmeMethod)}
                                >
                                    <FormSelectOption value="nginx" label={_("nginx plugin (recommended)")} />
                                    <FormSelectOption value="webroot" label={_("Webroot (sites created here)")} />
                                    <FormSelectOption value="standalone" label={_("Standalone (nginx must be stopped)")} />
                                </FormSelect>
                                <FormHelper
fieldId="le-method"
                                            helperText={method === "webroot"
                                                ? cockpit.format(_("Challenges are served from $0 through the ACME location in managed sites."), acmeWebroot)
                                                : method === "standalone"
                                                    ? _("certbot listens on port 80 itself, so nginx must not be running.")
                                                    : _("certbot temporarily adjusts the nginx configuration to answer the challenge.")}
                                />
                            </FormGroup>
                            <FormGroup fieldId="le-staging">
                                <Checkbox
id="le-staging" isChecked={staging} onChange={(_ev, v) => setStaging(v)}
                                          label={_("Use the staging environment (test certificate, not trusted by browsers)")}
                                />
                            </FormGroup>
                            <FormGroup fieldId="le-agree" isRequired>
                                <Checkbox
id="le-agree" isChecked={agree} onChange={(_ev, v) => setAgree(v)}
                                          label={
                                              <>
                                                  {_("I agree to the ")}
                                                  <a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener noreferrer">
                                                      {_("Let's Encrypt Subscriber Agreement")}
                                                  </a>
                                              </>
                                          }
                                />
                                <FormHelper fieldId="le-agree" helperTextInvalid={errors.agree} />
                            </FormGroup>
                        </Form>}
                    {siteName && onIssued && phase === "form" &&
                        <Alert
isInline isPlain variant="info"
                               title={cockpit.format(_("The site $0 will be updated to use this certificate."), siteName)}
                        />}
                    {(running || finished) &&
                        <CodeBlock>
                            <CodeBlockCode>
                                <div ref={outputRef} className="nginx-manager-output">
                                    {output || (running ? _("Running certbot...") : "")}
                                </div>
                            </CodeBlockCode>
                        </CodeBlock>}
                </Stack>
            </ModalBody>
            <ModalFooter>
                {phase === "form" &&
                    <Button variant="primary" onClick={request}>{_("Request certificate")}</Button>}
                {running &&
                    <Button variant="primary" isLoading isDisabled>{_("Requesting...")}</Button>}
                {finished &&
                    <Button variant="primary" onClick={Dialogs.close}>{_("Close")}</Button>}
                {!finished &&
                    <Button variant="link" onClick={Dialogs.close} isDisabled={running}>{_("Cancel")}</Button>}
            </ModalFooter>
        </Modal>
    );
};
