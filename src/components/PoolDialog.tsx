/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection/index.js";
import { Form, FormGroup, FormSection } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio/index.js";
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { FormHelper } from "cockpit-components-form-helper.jsx";
import { ModalError } from "cockpit-components-inline-notification.jsx";

import { errorMessage } from "../lib/nginx";
import { PhpInfo, PoolEntry, savePool } from "../lib/php";
import {
    PoolConfig, ProcessManager, defaultPool, poolSocketPath,
    POOL_USER_RE, PHP_SIZE_RE, TZ_RE, PATH_LIST_RE,
} from "../lib/pools";
import { NAME_RE, isValidAddress } from "../lib/templates";

const _ = cockpit.gettext;

const NEW_USER = "?new";

export const pmLabel = (pm: ProcessManager): string => {
    switch (pm) {
    case "dynamic": return _("Dynamic (keep spare workers ready)");
    case "ondemand": return _("On demand (start workers when needed)");
    case "static": return _("Static (fixed number of workers)");
    default: return pm;
    }
};

function parseInt_(text: string): number | null {
    return /^\d+$/.test(text.trim()) ? Number(text) : null;
}

export const PoolDialog = ({ entry, pools, info, onDone }: {
    entry?: PoolEntry | undefined,
    pools: PoolEntry[],
    info: PhpInfo,
    onDone: () => void,
}) => {
    const Dialogs = useDialogs();
    const editing = !!entry;
    const meta: PoolConfig = entry?.meta ?? defaultPool();
    const knownUser = info.users.some(u => u.name === meta.user);

    const [name, setName] = useState(meta.name);
    const [userChoice, setUserChoice] = useState(meta.user ? (knownUser ? meta.user : NEW_USER) : (info.users[0]?.name ?? NEW_USER));
    const [newUser, setNewUser] = useState(knownUser ? "" : meta.user);
    const [listenType, setListenType] = useState<"socket" | "tcp">(meta.listen.type);
    const [address, setAddress] = useState(meta.listen.type === "tcp" ? meta.listen.address : "127.0.0.1");
    const [port, setPort] = useState(meta.listen.type === "tcp" ? String(meta.listen.port) : "9000");
    const [pm, setPm] = useState<ProcessManager>(meta.pm);
    const [maxChildren, setMaxChildren] = useState(String(meta.maxChildren));
    const [startServers, setStartServers] = useState(String(meta.startServers ?? 2));
    const [minSpare, setMinSpare] = useState(String(meta.minSpare ?? 1));
    const [maxSpare, setMaxSpare] = useState(String(meta.maxSpare ?? 3));
    const [idleTimeout, setIdleTimeout] = useState(String(meta.idleTimeout ?? 10));
    const [maxRequests, setMaxRequests] = useState(meta.maxRequests === undefined ? "" : String(meta.maxRequests));
    const [memoryLimit, setMemoryLimit] = useState(meta.memoryLimit ?? "");
    const [uploadMax, setUploadMax] = useState(meta.uploadMaxFilesize ?? "");
    const [postMax, setPostMax] = useState(meta.postMaxSize ?? "");
    const [maxExecution, setMaxExecution] = useState(meta.maxExecutionTime === undefined ? "" : String(meta.maxExecutionTime));
    const [openBasedir, setOpenBasedir] = useState(meta.openBasedir ?? "");
    const [timezone, setTimezone] = useState(meta.timezone ?? "");
    const [displayErrors, setDisplayErrors] = useState(meta.displayErrors ?? false);
    const [slowlog, setSlowlog] = useState(meta.slowlogTimeout === undefined ? "" : String(meta.slowlogTimeout));
    const [extra, setExtra] = useState(meta.extra ?? "");
    const [advancedOpen, setAdvancedOpen] = useState(!!meta.extra);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const effectiveUser = userChoice === NEW_USER ? newUser.trim() : userChoice;
    const effectiveGroup = userChoice === NEW_USER ? newUser.trim() : (info.users.find(u => u.name === userChoice)?.group ?? userChoice);

    const validate = (): PoolConfig | null => {
        const errs: Record<string, string> = {};
        if (!NAME_RE.test(name))
            errs.name = _("Use only letters, digits, dots, dashes and underscores");
        else if (!editing && pools.some(p => p.name === name || p.section === name))
            errs.name = _("A pool with this name already exists");
        if (!POOL_USER_RE.test(effectiveUser))
            errs.user = _("Enter a lowercase user name (letters, digits, dashes, underscores)");

        let listen: PoolConfig["listen"] = { type: "socket" };
        if (listenType === "tcp") {
            const p = parseInt_(port);
            if (!isValidAddress(address.trim()))
                errs.address = _("Enter an IP address, usually 127.0.0.1");
            if (p === null || p < 1 || p > 65535)
                errs.port = _("Enter a port between 1 and 65535");
            else
                listen = { type: "tcp", address: address.trim(), port: p };
        }

        const children = parseInt_(maxChildren);
        if (children === null || children < 1)
            errs.maxChildren = _("Enter a number greater than 0");
        const start = parseInt_(startServers);
        const min = parseInt_(minSpare);
        const max = parseInt_(maxSpare);
        if (pm === "dynamic") {
            if (start === null || min === null || max === null || min < 1)
                errs.spare = _("Enter numbers greater than 0");
            else if (children !== null && !(min <= start && start <= max && max <= children))
                errs.spare = _("Required: min spare ≤ start ≤ max spare ≤ max children");
        }
        const idle = parseInt_(idleTimeout);
        if (pm === "ondemand" && (idle === null || idle < 1))
            errs.idleTimeout = _("Enter a number of seconds greater than 0");
        const requests = maxRequests.trim() ? parseInt_(maxRequests) : 0;
        if (requests === null)
            errs.maxRequests = _("Enter a whole number, or leave empty");

        for (const [key, value] of [["memoryLimit", memoryLimit], ["uploadMax", uploadMax], ["postMax", postMax]] as const) {
            if (value.trim() && !PHP_SIZE_RE.test(value.trim()))
                errs[key] = _("Enter a size such as 128M or 1G");
        }
        const execution = maxExecution.trim() ? parseInt_(maxExecution) : undefined;
        if (execution === null)
            errs.maxExecution = _("Enter a number of seconds (0 = unlimited)");
        if (openBasedir.trim() && !PATH_LIST_RE.test(openBasedir.trim()))
            errs.openBasedir = _("Enter one or more absolute paths separated by colons");
        if (timezone.trim() && !TZ_RE.test(timezone.trim()))
            errs.timezone = _("Enter a zone such as Europe/Madrid");
        const slow = slowlog.trim() ? parseInt_(slowlog) : 0;
        if (slow === null)
            errs.slowlog = _("Enter a number of seconds, or leave empty");

        setErrors(errs);
        if (Object.keys(errs).length > 0)
            return null;

        const pool: PoolConfig = {
            version: 1,
            name,
            user: effectiveUser,
            group: effectiveGroup,
            listen,
            pm,
            maxChildren: children as number,
        };
        if (pm === "dynamic") {
            pool.startServers = start as number;
            pool.minSpare = min as number;
            pool.maxSpare = max as number;
        } else if (pm === "ondemand") {
            pool.idleTimeout = idle as number;
        }
        if (requests)
            pool.maxRequests = requests;
        if (memoryLimit.trim())
            pool.memoryLimit = memoryLimit.trim().toUpperCase();
        if (uploadMax.trim())
            pool.uploadMaxFilesize = uploadMax.trim().toUpperCase();
        if (postMax.trim())
            pool.postMaxSize = postMax.trim().toUpperCase();
        if (execution !== undefined && execution !== null)
            pool.maxExecutionTime = execution;
        if (openBasedir.trim())
            pool.openBasedir = openBasedir.trim();
        if (timezone.trim())
            pool.timezone = timezone.trim();
        if (displayErrors)
            pool.displayErrors = true;
        if (slow)
            pool.slowlogTimeout = slow;
        if (extra.trim())
            pool.extra = extra.trim();
        return pool;
    };

    const save = async () => {
        const pool = validate();
        if (!pool)
            return;
        setBusy(true);
        setError(null);
        try {
            await savePool(pool, { previous: entry, info, createUser: userChoice === NEW_USER });
            Dialogs.close();
            onDone();
        } catch (ex) {
            setError(errorMessage(ex));
            setBusy(false);
        }
    };

    const field = (id: string, key: string, label: string, value: string, onChange: (v: string) => void, opts: {
        required?: boolean, placeholder?: string, help?: string, type?: "text" | "number", disabled?: boolean,
    } = {}) => (
        <FormGroup label={label} fieldId={id} isRequired={!!opts.required}>
            <TextInput
id={id} value={value} onChange={(_ev, v) => onChange(v)}
                       type={opts.type || "text"} placeholder={opts.placeholder || ""} isDisabled={!!opts.disabled}
                       validated={errors[key] ? "error" : "default"}
            />
            <FormHelper fieldId={id} helperTextInvalid={errors[key]} helperText={opts.help} />
        </FormGroup>
    );

    return (
        <Modal position="top" variant="medium" isOpen onClose={Dialogs.close}>
            <ModalHeader title={editing ? cockpit.format(_("Edit pool $0"), entry.name) : _("Add PHP-FPM pool")} />
            <ModalBody>
                <Stack hasGutter>
                    {error && <ModalError dialogError={_("The pool was not saved")} dialogErrorDetail={error} />}
                    <Form isHorizontal onSubmit={ev => { ev.preventDefault(); save() }}>
                        {field("pool-name", "name", _("Name"), name, setName, {
                            required: true,
                            disabled: editing,
                            help: cockpit.format(_("Configuration file $0/<name>.conf, socket $1"), info.poolDir, poolSocketPath(name || "<name>", info.runDir)),
                        })}
                        <FormGroup label={_("Run as user")} fieldId="pool-user" isRequired>
                            <FormSelect id="pool-user" value={userChoice} onChange={(_ev, v) => setUserChoice(v)}>
                                {info.users.map(u => <FormSelectOption key={u.name} value={u.name} label={`${u.name} (${u.group})`} />)}
                                <FormSelectOption value={NEW_USER} label={_("New system user...")} />
                            </FormSelect>
                            <FormHelper
fieldId="pool-user"
                                        helperText={_("The user must be able to read the site's files. A dedicated user per site keeps sites isolated from each other.")}
                            />
                        </FormGroup>
                        {userChoice === NEW_USER &&
                            field("pool-new-user", "user", _("User name"), newUser, setNewUser, {
                                required: true,
                                placeholder: name ? `php-${name}` : "php-site",
                                help: _("Created as a system account without login shell, with a group of the same name."),
                            })}

                        <FormSection title={_("Listening")}>
                            <FormGroup fieldId="pool-listen" role="radiogroup">
                                <Radio
id="pool-listen-socket" name="pool-listen" isChecked={listenType === "socket"}
                                       onChange={() => setListenType("socket")}
                                       label={_("Unix socket")}
                                       description={cockpit.format(_("$0, readable by the web server user ($1). Recommended."), poolSocketPath(name || "<name>", info.runDir), info.webUser)}
                                />
                                <Radio
id="pool-listen-tcp" name="pool-listen" isChecked={listenType === "tcp"}
                                       onChange={() => setListenType("tcp")}
                                       label={_("TCP port")}
                                       description={_("For applications in containers or on other hosts.")}
                                />
                            </FormGroup>
                            {listenType === "tcp" &&
                                <>
                                    {field("pool-address", "address", _("Address"), address, setAddress, { required: true })}
                                    {field("pool-port", "port", _("Port"), port, setPort, { required: true, type: "number" })}
                                </>}
                        </FormSection>

                        <FormSection title={_("Processes")}>
                            <FormGroup label={_("Process manager")} fieldId="pool-pm">
                                <FormSelect id="pool-pm" value={pm} onChange={(_ev, v) => setPm(v as ProcessManager)}>
                                    <FormSelectOption value="dynamic" label={pmLabel("dynamic")} />
                                    <FormSelectOption value="ondemand" label={pmLabel("ondemand")} />
                                    <FormSelectOption value="static" label={pmLabel("static")} />
                                </FormSelect>
                                <FormHelper
fieldId="pool-pm"
                                            helperText={_("On demand suits small sites with little traffic; dynamic keeps latency low on busy ones.")}
                                />
                            </FormGroup>
                            {field("pool-max-children", "maxChildren", _("Max workers"), maxChildren, setMaxChildren, {
                                required: true,
                                type: "number",
                                help: _("Upper limit of PHP processes. Each one uses roughly the memory limit below at worst."),
                            })}
                            {pm === "dynamic" &&
                                <FormGroup label={_("Spare workers")} fieldId="pool-start">
                                    <Stack hasGutter>
                                        <TextInput
id="pool-start" type="number" value={startServers} onChange={(_ev, v) => setStartServers(v)}
                                                   aria-label={_("Start servers")} validated={errors.spare ? "error" : "default"}
                                        />
                                        <TextInput
id="pool-min-spare" type="number" value={minSpare} onChange={(_ev, v) => setMinSpare(v)}
                                                   aria-label={_("Minimum spare")} validated={errors.spare ? "error" : "default"}
                                        />
                                        <TextInput
id="pool-max-spare" type="number" value={maxSpare} onChange={(_ev, v) => setMaxSpare(v)}
                                                   aria-label={_("Maximum spare")} validated={errors.spare ? "error" : "default"}
                                        />
                                    </Stack>
                                    <FormHelper
fieldId="pool-start" helperTextInvalid={errors.spare}
                                                helperText={_("Workers started at launch, minimum idle and maximum idle, in that order.")}
                                    />
                                </FormGroup>}
                            {pm === "ondemand" &&
                                field("pool-idle", "idleTimeout", _("Idle timeout (s)"), idleTimeout, setIdleTimeout, {
                                    required: true,
                                    type: "number",
                                    help: _("Idle workers are stopped after this many seconds."),
                                })}
                            {field("pool-max-requests", "maxRequests", _("Recycle after requests"), maxRequests, setMaxRequests, {
                                type: "number",
                                placeholder: _("never"),
                                help: _("Restart each worker after this many requests to contain memory leaks. 500 is a common value."),
                            })}
                        </FormSection>

                        <FormSection title={_("PHP settings")}>
                            {field("pool-memory", "memoryLimit", _("Memory limit"), memoryLimit, setMemoryLimit, {
                                placeholder: _("php.ini default"),
                            })}
                            {field("pool-upload", "uploadMax", _("Max upload file size"), uploadMax, setUploadMax, {
                                placeholder: _("php.ini default"),
                                help: _("Keep the site's maximum upload size in nginx at least as large."),
                            })}
                            {field("pool-post", "postMax", _("Max POST size"), postMax, setPostMax, {
                                placeholder: _("php.ini default"),
                            })}
                            {field("pool-execution", "maxExecution", _("Max execution time (s)"), maxExecution, setMaxExecution, {
                                type: "number",
                                placeholder: _("php.ini default"),
                            })}
                            {field("pool-timezone", "timezone", _("Time zone"), timezone, setTimezone, {
                                placeholder: "Europe/Madrid",
                            })}
                            {field("pool-basedir", "openBasedir", _("open_basedir"), openBasedir, setOpenBasedir, {
                                placeholder: "/var/www/site:/tmp",
                                help: _("Restrict which paths PHP may open. Separate several with colons; include the session and upload temp directories."),
                            })}
                            <FormGroup fieldId="pool-display-errors">
                                <Checkbox
id="pool-display-errors" isChecked={displayErrors} onChange={(_ev, v) => setDisplayErrors(v)}
                                          label={_("Show PHP errors in the browser (development only)")}
                                />
                            </FormGroup>
                            {field("pool-slowlog", "slowlog", _("Slow request log (s)"), slowlog, setSlowlog, {
                                type: "number",
                                placeholder: _("off"),
                                help: cockpit.format(_("Log a backtrace of requests slower than this many seconds to $0/<name>-slow.log"), info.logDir),
                            })}
                        </FormSection>

                        <ExpandableSection
toggleText={_("Advanced")} isExpanded={advancedOpen}
                                           onToggle={(_ev, v) => setAdvancedOpen(v)} isIndented
                        >
                            <FormGroup label={_("Extra directives")} fieldId="pool-extra">
                                <TextArea
id="pool-extra" className="nginx-manager-code" value={extra}
                                          onChange={(_ev, v) => setExtra(v)} rows={6} resizeOrientation="vertical"
                                          spellCheck={false}
                                          placeholder={"env[APP_ENV] = production\nphp_admin_value[sendmail_path] = /usr/sbin/sendmail -t -i"}
                                />
                                <FormHelper
fieldId="pool-extra"
                                            helperText={_("Appended verbatim to the pool section. Validated with \"php-fpm -t\" before applying.")}
                                />
                            </FormGroup>
                        </ExpandableSection>
                    </Form>
                    <Alert
isInline isPlain variant="info"
                           title={cockpit.format(_("Sessions are stored in $0/<name>, owned by the pool user."), info.sessionsDir)}
                    />
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
