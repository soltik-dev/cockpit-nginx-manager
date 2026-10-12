/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from 'cockpit';

import { CertInfo } from "../lib/nginx";

const _ = cockpit.gettext;

/* ISO 8601 in local time: unambiguous in any language (cockpit.language stays "en" without translations) */
const pad = (n: number): string => String(n).padStart(2, "0");
export const isoDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const isoDateTime = (d: Date): string => `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const sourceLabel = (cert: CertInfo): string =>
    cert.source === "letsencrypt" ? _("Let's Encrypt") : _("Self-signed");

export function expiryText(cert: CertInfo): string {
    if (!cert.notAfter || cert.daysLeft === null)
        return _("Unknown");
    const when = isoDate(new Date(cert.notAfter));
    if (cert.daysLeft < 0)
        return cockpit.format(_("expired on $0"), when);
    return cockpit.format(_("expires $0"), when);
}

export function certLabel(cert: CertInfo): string {
    return `${cert.name} (${sourceLabel(cert)}, ${expiryText(cert)})`;
}
