// SPDX-License-Identifier: LGPL-2.1-or-later

// build.js loads *.py files as plain text so they can be passed to `python3 -c`
declare module "*.py" {
    const content: string;
    export default content;
}
