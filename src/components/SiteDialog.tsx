/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Form, FormGroup, FormSection } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { FormHelper } from "cockpit-components-form-helper.jsx";
import { ModalError } from "cockpit-components-inline-notification.jsx";

import { CertInfo, NginxInfo, SiteEntry, HtpasswdChanges, saveSite, listHtpasswd, errorMessage } from "../lib/nginx";
import { PhpInfo, PoolEntry, poolFastcgi } from "../lib/php";
import {
    SiteConfig, SiteType, TlsConfig, RenderFeatures,
    NAME_RE, DOMAIN_RE, VALUE_RE, URL_RE, SIZE_RE, CIDR_RE, USER_RE, DEFAULT_PHP_SOCKET,
    nameFromDomain, parseDomains, parseList, isValidAddress,
} from "../lib/templates";
import { certLabel } from "./certs";

const _ = cockpit.gettext;

export const typeLabel = (type: SiteType): string => {
    switch (type) {
    case "static": return _("Static website");
    case "proxy": return _("Reverse proxy");
    case "php": return _("PHP (FastCGI)");
    case "redirect": return _("Redirect");
    default: return type;
    }
};

const CUSTOM = "custom";
const NONE = "none";

function initialTlsChoice(tls: TlsConfig | undefined, certs: CertInfo[]): string {
    if (!tls || tls.mode !== "cert")
        return NONE;
    const known = certs.find(c => c.cert === tls.cert && c.key === tls.key);
    return known ? known.id : CUSTOM;
}

function parsePort(text: string): number | null {
    const n = Number(text);
    return /^\d+$/.test(text.trim()) && n >= 1 && n <= 65535 ? n : null;
}

const OTHER_SOCKET = "?other";

export const SiteDialog = ({ entry, sites, certs, info, php, pools, features, onDone }: {
    entry?: SiteEntry | undefined,
    sites: SiteEntry[],
    certs: CertInfo[],
    info: NginxInfo | null,
    php: PhpInfo | null,
    pools: PoolEntry[],
    features: RenderFeatures,
    onDone: () => void,
}) => {
    const Dialogs = useDialogs();
    const meta = entry?.meta ?? undefined;
    const editing = !!entry;
    const oldTls = meta && meta.tls.mode === "cert" ? meta.tls : null;

    /* identity */
    const [name, setName] = useState(meta?.name ?? "");
    const [nameTouched, setNameTouched] = useState(editing);
    const [type, setType] = useState<SiteType>(meta?.type ?? "static");
    const [domainsText, setDomainsText] = useState(meta?.domains.join(" ") ?? "");
    const [canonical, setCanonical] = useState(meta?.canonical ?? "");

    /* content */
    const [root, setRoot] = useState(meta?.root ?? "");
    const [rootTouched, setRootTouched] = useState(!!meta?.root);
    const [spa, setSpa] = useState(meta?.spa ?? false);
    const [createRoot, setCreateRoot] = useState(!editing);
    const [upstream, setUpstream] = useState(meta?.upstream ?? "http://127.0.0.1:8080");
    const [websockets, setWebsockets] = useState(meta?.websockets ?? true);
    const poolOptions = php
        ? pools
                .filter(p => p.enabled)
                .map(p => ({ value: poolFastcgi(p, php) || "", label: `${p.section} (${poolFastcgi(p, php)})` }))
                .filter(o => o.value)
        : [];
    const initialSocket = meta?.phpSocket ?? (poolOptions[0]?.value || info?.phpSockets[0] || DEFAULT_PHP_SOCKET);
    const [phpSocket, setPhpSocket] = useState(initialSocket);
    const [poolChoice, setPoolChoice] = useState(poolOptions.some(o => o.value === initialSocket) ? initialSocket : OTHER_SOCKET);
    const [redirectTo, setRedirectTo] = useState(meta?.redirectTo ?? "");
    const [redirectKeepPath, setRedirectKeepPath] = useState(meta?.redirectKeepPath ?? true);
    const [redirectTemporary, setRedirectTemporary] = useState(meta?.redirectTemporary ?? false);

    /* tls */
    const [tlsChoice, setTlsChoice] = useState(initialTlsChoice(meta?.tls, certs));
    const [customCert, setCustomCert] = useState(oldTls?.cert ?? "");
    const [customKey, setCustomKey] = useState(oldTls?.key ?? "");
    const [redirect, setRedirect] = useState(oldTls?.redirect ?? true);
    const [hsts, setHsts] = useState(oldTls?.hsts ?? false);

    /* listening */
    const [httpPort, setHttpPort] = useState(String(meta?.httpPort ?? 80));
    const [httpsPort, setHttpsPort] = useState(String(meta?.httpsPort ?? 443));
    const [listenAddress, setListenAddress] = useState(meta?.listenAddress ?? "");
    const [ipv6, setIpv6] = useState(meta?.ipv6 ?? true);
    const [openFirewall, setOpenFirewall] = useState(false);

    /* access */
    const [allowFromText, setAllowFromText] = useState(meta?.allowFrom?.join(" ") ?? "");
    const [authEnabled, setAuthEnabled] = useState(!!meta?.basicAuth);
    const [authRealm, setAuthRealm] = useState(meta?.basicAuth?.realm ?? "Restricted");
    const [authUsers, setAuthUsers] = useState<string[]>(meta?.basicAuth?.users ?? []);
    const [authRemoved, setAuthRemoved] = useState<string[]>([]);
    const [authNew, setAuthNew] = useState<Record<string, string>>({});
    const [newUser, setNewUser] = useState("");
    const [newPassword, setNewPassword] = useState("");

    /* options */
    const [maxBodySize, setMaxBodySize] = useState(meta?.maxBodySize ?? "");
    const [disableAccessLog, setDisableAccessLog] = useState(meta?.disableAccessLog ?? false);
    const [securityHeaders, setSecurityHeaders] = useState(meta?.securityHeaders ?? false);
    const [staticCache, setStaticCache] = useState(meta?.staticCache ?? false);
    const [extra, setExtra] = useState(meta?.extra ?? "");
    const [advancedOpen, setAdvancedOpen] = useState(!!meta?.extra);

    const [errors, setErrors] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    /* the htpasswd file is the truth about users; the header only mirrors it */
    useEffect(() => {
        if (!entry)
            return;
        listHtpasswd(entry.name)
                .then(users => setAuthUsers(users))
                .catch(() => { /* keep the names from the header */ });
    }, [entry]);

    const domains = parseDomains(domainsText);
    const effectiveRoot = root || (name ? `/var/www/${name}` : "");
    const hasRoot = type === "static" || type === "php";
    const hasTls = tlsChoice !== NONE;
    const effectiveUsers = [
        ...authUsers.filter(u => !authRemoved.includes(u) && !(u in authNew)),
        ...Object.keys(authNew),
    ].sort();
    const nonStandardPorts = [
        ...(httpPort.trim() !== "80" ? [parsePort(httpPort)] : []),
        ...(hasTls && httpsPort.trim() !== "443" ? [parsePort(httpsPort)] : []),
    ].filter((p): p is number => p !== null);

    const onDomainsChange = (value: string) => {
        setDomainsText(value);
        if (!nameTouched) {
            const list = parseDomains(value);
            setName(list.length ? nameFromDomain(list[0]) : "");
        }
    };

    const onNameChange = (value: string) => {
        setName(value);
        setNameTouched(true);
        if (!rootTouched)
            setRoot("");
    };

    const addUser = () => {
        const user = newUser.trim();
        if (!USER_RE.test(user)) {
            setErrors({ ...errors, authUsers: _("User names may contain letters, digits, dots, dashes, underscores and @") });
            return;
        }
        if (!newPassword) {
            setErrors({ ...errors, authUsers: _("Enter a password") });
            return;
        }
        setAuthNew({ ...authNew, [user]: newPassword });
        setAuthRemoved(authRemoved.filter(u => u !== user));
        setNewUser("");
        setNewPassword("");
        const rest = { ...errors };
        delete rest.authUsers;
        setErrors(rest);
    };

    const removeUser = (user: string) => {
        if (user in authNew) {
            const rest = { ...authNew };
            delete rest[user];
            setAuthNew(rest);
        } else {
            setAuthRemoved([...authRemoved, user]);
        }
    };

    const validate = (): SiteConfig | null => {
        const errs: Record<string, string> = {};

        if (!NAME_RE.test(name))
            errs.name = _("Use only letters, digits, dots, dashes and underscores");
        else if (!editing && sites.some(s => s.name === name))
            errs.name = _("A site with this name already exists");

        if (domains.length === 0)
            errs.domains = _("At least one domain is required");
        else if (domains.some(d => !DOMAIN_RE.test(d)))
            errs.domains = _("Invalid domain name");

        if (hasRoot && (!effectiveRoot.startsWith("/") || !VALUE_RE.test(effectiveRoot)))
            errs.root = _("Enter an absolute path without spaces");
        if (type === "proxy" && !/^(https?:\/\/|unix:)[^\s;{}"'#]+$/.test(upstream))
            errs.upstream = _("Enter a URL such as http://127.0.0.1:8080");
        if (type === "php" && !VALUE_RE.test(phpSocket))
            errs.phpSocket = _("Enter a socket such as unix:/run/php-fpm/www.sock or 127.0.0.1:9000");
        if (type === "redirect" && !URL_RE.test(redirectTo))
            errs.redirectTo = _("Enter a URL such as https://www.example.com");

        let tls: TlsConfig = { mode: "none" };
        if (tlsChoice === CUSTOM) {
            if (!customCert.startsWith("/") || !VALUE_RE.test(customCert))
                errs.customCert = _("Enter an absolute path without spaces");
            if (!customKey.startsWith("/") || !VALUE_RE.test(customKey))
                errs.customKey = _("Enter an absolute path without spaces");
            tls = { mode: "cert", cert: customCert, key: customKey, redirect, hsts };
        } else if (tlsChoice !== NONE) {
            const cert = certs.find(c => c.id === tlsChoice);
            if (!cert)
                errs.tls = _("Select a certificate");
            else
                tls = { mode: "cert", cert: cert.cert, key: cert.key, redirect, hsts };
        }

        const http = parsePort(httpPort);
        const https = parsePort(httpsPort);
        if (http === null)
            errs.httpPort = _("Enter a port between 1 and 65535");
        if (hasTls && https === null)
            errs.httpsPort = _("Enter a port between 1 and 65535");
        if (hasTls && http !== null && https !== null && http === https)
            errs.httpsPort = _("HTTP and HTTPS must use different ports");
        if (listenAddress.trim() && !isValidAddress(listenAddress.trim()))
            errs.listenAddress = _("Enter an IPv4 or IPv6 address, or leave empty for all");

        const allowFrom = parseList(allowFromText);
        if (allowFrom.some(n => !CIDR_RE.test(n)))
            errs.allowFrom = _("Enter IP addresses or networks such as 192.168.1.0/24, separated by spaces");

        if (authEnabled) {
            if (!authRealm.trim() || /["\n]/.test(authRealm))
                errs.authRealm = _("Enter a short text without quotes");
            if (effectiveUsers.length === 0)
                errs.authUsers = _("Add at least one user");
        }
        if (maxBodySize.trim() && !SIZE_RE.test(maxBodySize.trim()))
            errs.maxBodySize = _("Enter a size such as 64m or 1g");

        setErrors(errs);
        if (Object.keys(errs).length > 0)
            return null;

        const site: SiteConfig = { version: 1, name, type, domains, tls };
        if (canonical && domains.length > 1 && domains.includes(canonical))
            site.canonical = canonical;
        if (http !== null && http !== 80)
            site.httpPort = http;
        if (hasTls && https !== null && https !== 443)
            site.httpsPort = https;
        if (listenAddress.trim())
            site.listenAddress = listenAddress.trim();
        if (!ipv6)
            site.ipv6 = false;
        if (type === "static") {
            site.root = effectiveRoot;
            site.spa = spa;
        } else if (type === "proxy") {
            site.upstream = upstream;
            site.websockets = websockets;
        } else if (type === "php") {
            site.root = effectiveRoot;
            site.phpSocket = phpSocket;
        } else if (type === "redirect") {
            site.redirectTo = redirectTo;
            site.redirectKeepPath = redirectKeepPath;
            if (redirectTemporary)
                site.redirectTemporary = true;
        }
        if (allowFrom.length)
            site.allowFrom = allowFrom;
        if (authEnabled)
            site.basicAuth = { realm: authRealm.trim(), users: effectiveUsers };
        if (maxBodySize.trim())
            site.maxBodySize = maxBodySize.trim();
        if (disableAccessLog)
            site.disableAccessLog = true;
        if (securityHeaders)
            site.securityHeaders = true;
        if (staticCache && hasRoot)
            site.staticCache = true;
        if (extra.trim())
            site.extra = extra.trim();
        return site;
    };

    const save = async () => {
        const site = validate();
        if (!site)
            return;
        setBusy(true);
        setError(null);
        let htpasswd: HtpasswdChanges | undefined;
        if (authEnabled && (Object.keys(authNew).length || authRemoved.length))
            htpasswd = { set: authNew, remove: authRemoved };
        try {
            await saveSite(site, {
                previous: entry,
                createRoot: hasRoot && createRoot,
                features,
                htpasswd,
                openPorts: openFirewall ? nonStandardPorts : undefined,
            });
            Dialogs.close();
            onDone();
        } catch (ex) {
            setError(errorMessage(ex));
            setBusy(false);
        }
    };

    const field = (id: string, label: string, value: string, onChange: (v: string) => void, opts: {
        required?: boolean, placeholder?: string, help?: string, type?: "text" | "number" | "password", disabled?: boolean,
    } = {}) => {
        const key = id.replace("site-", "");
        return (
            <FormGroup label={label} fieldId={id} isRequired={!!opts.required}>
                <TextInput
id={id} value={value} onChange={(_ev, v) => onChange(v)}
                           type={opts.type || "text"} placeholder={opts.placeholder || ""} isDisabled={!!opts.disabled}
                           validated={errors[key] ? "error" : "default"}
                />
                <FormHelper fieldId={id} helperTextInvalid={errors[key]} helperText={opts.help} />
            </FormGroup>
        );
    };

    return (
        <Modal position="top" variant="medium" isOpen onClose={Dialogs.close}>
            <ModalHeader title={editing ? cockpit.format(_("Edit site $0"), entry.name) : _("Add site")} />
            <ModalBody>
                <Stack hasGutter>
                    {error && <ModalError dialogError={_("The site was not saved")} dialogErrorDetail={error} />}
                    <Form isHorizontal onSubmit={ev => { ev.preventDefault(); save() }}>
                        {field("site-domains", _("Domains"), domainsText, onDomainsChange, {
                            required: true,
                            placeholder: "example.com www.example.com",
                            help: _("Separate several names with spaces. Use \"_\" for a catch-all server."),
                        })}
                        {domains.length > 1 &&
                            <FormGroup label={_("Canonical host")} fieldId="site-canonical">
                                <FormSelect id="site-canonical" value={canonical} onChange={(_ev, v) => setCanonical(v)}>
                                    <FormSelectOption value="" label={_("None (serve all domains)")} />
                                    {domains.filter(d => d !== "_").map(d => <FormSelectOption key={d} value={d} label={d} />)}
                                </FormSelect>
                                <FormHelper
fieldId="site-canonical"
                                            helperText={_("The other domains redirect permanently to this one, for example www to the bare domain.")}
                                />
                            </FormGroup>}
                        {field("site-name", _("Name"), name, onNameChange, {
                            required: true,
                            disabled: editing,
                            help: cockpit.format(_("Configuration file $0/<name>.conf and log files in /var/log/nginx"), info?.confDir || "/etc/nginx/conf.d"),
                        })}
                        <FormGroup label={_("Type")} fieldId="site-type">
                            <FormSelect id="site-type" value={type} onChange={(_ev, v) => setType(v as SiteType)}>
                                <FormSelectOption value="static" label={typeLabel("static")} />
                                <FormSelectOption value="proxy" label={typeLabel("proxy")} />
                                <FormSelectOption value="php" label={typeLabel("php")} />
                                <FormSelectOption value="redirect" label={typeLabel("redirect")} />
                            </FormSelect>
                        </FormGroup>

                        {hasRoot &&
                            <FormGroup label={_("Document root")} fieldId="site-root" isRequired>
                                <TextInput
id="site-root" value={root} placeholder={effectiveRoot || "/var/www/site"}
                                           onChange={(_ev, v) => { setRoot(v); setRootTouched(true) }}
                                           validated={errors.root ? "error" : "default"}
                                />
                                <FormHelper fieldId="site-root" helperTextInvalid={errors.root} />
                                <Checkbox
id="site-create-root" isChecked={createRoot} onChange={(_ev, v) => setCreateRoot(v)}
                                          label={_("Create the directory with a placeholder index.html if it does not exist")}
                                />
                            </FormGroup>}
                        {type === "static" &&
                            <FormGroup fieldId="site-spa">
                                <Checkbox
id="site-spa" isChecked={spa} onChange={(_ev, v) => setSpa(v)}
                                          label={_("Single-page application")}
                                          description={_("Serve index.html for paths that do not match a file (React, Vue, Angular routers).")}
                                />
                            </FormGroup>}
                        {type === "proxy" &&
                            <>
                                {field("site-upstream", _("Upstream"), upstream, setUpstream, {
                                    required: true,
                                    help: _("Address of the application to proxy to, for example http://127.0.0.1:3000 or unix:/run/app.sock"),
                                })}
                                <FormGroup fieldId="site-websockets">
                                    <Checkbox
id="site-websockets" isChecked={websockets} onChange={(_ev, v) => setWebsockets(v)}
                                              label={_("WebSocket support")}
                                    />
                                </FormGroup>
                            </>}
                        {type === "php" &&
                            <FormGroup label={_("PHP-FPM pool")} fieldId="site-pool" isRequired>
                                {poolOptions.length > 0 &&
                                    <FormSelect
id="site-pool" value={poolChoice}
                                                onChange={(_ev, v) => { setPoolChoice(v); if (v !== OTHER_SOCKET) setPhpSocket(v); }}
                                    >
                                        {poolOptions.map(o => <FormSelectOption key={o.value} value={o.value} label={o.label} />)}
                                        <FormSelectOption value={OTHER_SOCKET} label={_("Other socket or address...")} />
                                    </FormSelect>}
                                {(poolOptions.length === 0 || poolChoice === OTHER_SOCKET) &&
                                    <TextInput
id="site-phpSocket" value={phpSocket} onChange={(_ev, v) => setPhpSocket(v)}
                                               validated={errors.phpSocket ? "error" : "default"} aria-label={_("PHP-FPM socket")}
                                    />}
                                <FormHelper
fieldId="site-pool" helperTextInvalid={errors.phpSocket}
                                            helperText={poolOptions.length > 0
                                                ? _("Pools are managed in the PHP-FPM card. The pool user must be able to read the document root.")
                                                : info?.phpSockets.length
                                                    ? cockpit.format(_("Detected: $0"), info.phpSockets.join(", "))
                                                    : _("No PHP-FPM socket was detected; make sure php-fpm is installed and running.")}
                                />
                            </FormGroup>}
                        {type === "redirect" &&
                            <>
                                {field("site-redirectTo", _("Redirect to"), redirectTo, setRedirectTo, {
                                    required: true,
                                    placeholder: "https://www.example.com",
                                })}
                                <FormGroup fieldId="site-redirect-options">
                                    <Checkbox
id="site-redirect-keep" isChecked={redirectKeepPath} onChange={(_ev, v) => setRedirectKeepPath(v)}
                                              label={_("Keep the requested path and query string")}
                                    />
                                    <Checkbox
id="site-redirect-temporary" isChecked={redirectTemporary} onChange={(_ev, v) => setRedirectTemporary(v)}
                                              label={_("Temporary redirect (302 instead of 301)")}
                                    />
                                </FormGroup>
                            </>}

                        <FormSection title={_("TLS")}>
                            <FormGroup label={_("Certificate")} fieldId="site-tls">
                                <FormSelect
id="site-tls" value={tlsChoice} onChange={(_ev, v) => setTlsChoice(v)}
                                            validated={errors.tls ? "error" : "default"}
                                >
                                    <FormSelectOption value={NONE} label={_("None (HTTP only)")} />
                                    {certs.map(c => <FormSelectOption key={c.id} value={c.id} label={certLabel(c)} />)}
                                    <FormSelectOption value={CUSTOM} label={_("Custom certificate files...")} />
                                </FormSelect>
                                <FormHelper
fieldId="site-tls" helperTextInvalid={errors.tls}
                                            helperText={certs.length === 0 ? _("No certificates yet. Save the site and request one from its menu, or from the Certificates card.") : undefined}
                                />
                            </FormGroup>
                            {tlsChoice === CUSTOM &&
                                <>
                                    {field("site-customCert", _("Certificate file"), customCert, setCustomCert, {
                                        required: true,
                                        placeholder: "/etc/pki/tls/certs/example.crt",
                                        help: _("PEM file with the certificate followed by the intermediate chain"),
                                    })}
                                    {field("site-customKey", _("Private key file"), customKey, setCustomKey, {
                                        required: true,
                                        placeholder: "/etc/pki/tls/private/example.key",
                                    })}
                                </>}
                            {hasTls &&
                                <FormGroup fieldId="site-redirect">
                                    <Checkbox
id="site-redirect" isChecked={redirect} onChange={(_ev, v) => setRedirect(v)}
                                              label={_("Redirect HTTP to HTTPS")}
                                    />
                                    <Checkbox
id="site-hsts" isChecked={hsts && redirect} isDisabled={!redirect}
                                              onChange={(_ev, v) => setHsts(v)}
                                              label={_("Enable HSTS (Strict-Transport-Security, 2 years)")}
                                              description={_("Browsers will refuse plain HTTP for these domains for a long time. Enable only once HTTPS is known to work.")}
                                    />
                                </FormGroup>}
                        </FormSection>

                        <FormSection title={_("Listening")}>
                            {field("site-httpPort", _("HTTP port"), httpPort, setHttpPort, { type: "number", required: true })}
                            {hasTls && field("site-httpsPort", _("HTTPS port"), httpsPort, setHttpsPort, { type: "number", required: true })}
                            {field("site-listenAddress", _("Address"), listenAddress, setListenAddress, {
                                placeholder: _("All addresses"),
                                help: _("Bind to one IP address only, for example 192.168.1.10"),
                            })}
                            {!listenAddress.trim() &&
                                <FormGroup fieldId="site-ipv6">
                                    <Checkbox
id="site-ipv6" isChecked={ipv6} onChange={(_ev, v) => setIpv6(v)}
                                              label={_("Also listen on IPv6")}
                                              description={_("Turn off on hosts where IPv6 is disabled, otherwise nginx fails to start.")}
                                    />
                                </FormGroup>}
                            {nonStandardPorts.length > 0 &&
                                <FormGroup fieldId="site-firewall">
                                    <Checkbox
id="site-firewall" isChecked={openFirewall} onChange={(_ev, v) => setOpenFirewall(v)}
                                              label={cockpit.format(_("Open port(s) $0 in firewalld after saving"), nonStandardPorts.join(", "))}
                                              description={_("Ports 80 and 443 are covered by the http and https firewall services.")}
                                    />
                                </FormGroup>}
                        </FormSection>

                        <FormSection title={_("Access")}>
                            {field("site-allowFrom", _("Allowed networks"), allowFromText, setAllowFromText, {
                                placeholder: _("Everyone"),
                                help: _("Only these IP addresses or networks may connect, for example 192.168.1.0/24 10.8.0.0/16. Let's Encrypt challenges stay reachable."),
                            })}
                            <FormGroup fieldId="site-auth">
                                <Checkbox
id="site-auth" isChecked={authEnabled} onChange={(_ev, v) => setAuthEnabled(v)}
                                          label={_("Require a user name and password (HTTP basic authentication)")}
                                />
                            </FormGroup>
                            {authEnabled &&
                                <>
                                    {field("site-authRealm", _("Prompt text"), authRealm, setAuthRealm, { required: true })}
                                    <FormGroup label={_("Users")} fieldId="site-auth-user">
                                        <Stack hasGutter>
                                            {effectiveUsers.length > 0 &&
                                                <Flex spaceItems={{ default: "spaceItemsXs" }}>
                                                    {effectiveUsers.map(u =>
                                                        <Label
key={u} color={u in authNew ? "blue" : "grey"}
                                                               onClose={() => removeUser(u)} closeBtnAriaLabel={cockpit.format(_("Remove $0"), u)}
                                                        >
                                                            {u}
                                                        </Label>)}
                                                </Flex>}
                                            <Flex spaceItems={{ default: "spaceItemsSm" }} alignItems={{ default: "alignItemsFlexStart" }}>
                                                <FlexItem grow={{ default: "grow" }}>
                                                    <TextInput
id="site-auth-user" value={newUser} placeholder={_("User name")}
                                                               onChange={(_ev, v) => setNewUser(v)} aria-label={_("User name")}
                                                    />
                                                </FlexItem>
                                                <FlexItem grow={{ default: "grow" }}>
                                                    <TextInput
id="site-auth-password" type="password" value={newPassword} placeholder={_("Password")}
                                                               onChange={(_ev, v) => setNewPassword(v)} aria-label={_("Password")}
                                                               onKeyDown={ev => { if (ev.key === "Enter") { ev.preventDefault(); addUser() } }}
                                                    />
                                                </FlexItem>
                                                <Button id="site-auth-add" variant="secondary" onClick={addUser}>{_("Add user")}</Button>
                                            </Flex>
                                        </Stack>
                                        <FormHelper
fieldId="site-auth-user" helperTextInvalid={errors.authUsers}
                                                    helperText={_("Adding an existing user replaces their password. Passwords are stored hashed in /etc/nginx-manager/htpasswd/.")}
                                        />
                                    </FormGroup>
                                </>}
                        </FormSection>

                        <FormSection title={_("Options")}>
                            {type !== "redirect" &&
                                field("site-maxBodySize", _("Maximum upload size"), maxBodySize, setMaxBodySize, {
                                    placeholder: _("1m (nginx default)"),
                                    help: _("Largest request body accepted, for example 64m or 1g. Needed for file uploads."),
                                })}
                            <FormGroup fieldId="site-options">
                                <Checkbox
id="site-security-headers" isChecked={securityHeaders} onChange={(_ev, v) => setSecurityHeaders(v)}
                                          label={_("Add security headers")}
                                          description={_("X-Content-Type-Options, X-Frame-Options and Referrer-Policy.")}
                                />
                                {hasRoot &&
                                    <Checkbox
id="site-static-cache" isChecked={staticCache} onChange={(_ev, v) => setStaticCache(v)}
                                              label={_("Cache static assets for 30 days")}
                                              description={_("Images, stylesheets, scripts and fonts get long-lived cache headers.")}
                                    />}
                                <Checkbox
id="site-no-access-log" isChecked={disableAccessLog} onChange={(_ev, v) => setDisableAccessLog(v)}
                                          label={_("Disable the access log")}
                                />
                            </FormGroup>
                        </FormSection>

                        <ExpandableSection
toggleText={_("Advanced")} isExpanded={advancedOpen}
                                           onToggle={(_ev, v) => setAdvancedOpen(v)} isIndented
                        >
                            <FormGroup label={_("Extra directives")} fieldId="site-extra">
                                <TextArea
id="site-extra" className="nginx-manager-code" value={extra}
                                          onChange={(_ev, v) => setExtra(v)} rows={6} resizeOrientation="vertical"
                                          spellCheck={false}
                                          placeholder={"location /static/ {\n    alias /srv/app/static/;\n}"}
                                />
                                <FormHelper
fieldId="site-extra"
                                            helperText={_("Inserted verbatim at the end of the server block. Validated with \"nginx -t\" before applying.")}
                                />
                            </FormGroup>
                        </ExpandableSection>
                    </Form>
                </Stack>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" onClick={save} isLoading={busy} isDisabled={busy}>
                    {editing ? _("Save") : _("Add")}
                </Button>
                <Button variant="link" onClick={Dialogs.close} isDisabled={busy}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
