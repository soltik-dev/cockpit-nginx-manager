/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from 'cockpit';
import * as timeformat from 'timeformat';

import { CertInfo } from "../lib/nginx";

const _ = cockpit.gettext;

export const sourceLabel = (cert: CertInfo): string =>
    cert.source === "letsencrypt" ? _("Let's Encrypt") : _("Self-signed");

export function expiryText(cert: CertInfo): string {
    if (!cert.notAfter || cert.daysLeft === null)
        return _("Unknown");
    const when = timeformat.dateShort(new Date(cert.notAfter));
    if (cert.daysLeft < 0)
        return cockpit.format(_("expired on $0"), when);
    return cockpit.format(_("expires $0"), when);
}

export function certLabel(cert: CertInfo): string {
    return `${cert.name} (${sourceLabel(cert)}, ${expiryText(cert)})`;
}
