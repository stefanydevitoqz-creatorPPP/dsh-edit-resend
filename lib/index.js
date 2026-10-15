/**
 * Edit-and-resend surface plugin, node half.
 *
 * Pure UI plugin: the empty apply exists so the package appears in the host
 * loader, while the browser half ships through exports["./client"] and is
 * discovered from the package.json `dsh.client` declaration.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {}
