export const go = (path: string) => {
  window.location.hash = '/' + path;
};
/** Hash URL for the addressable repository page, with optional revision and
 * return-to (used so "Back" lands where the user came from). */
export function repoPath(
  repo: string,
  opts?: { revision?: string; returnTo?: string },
): string {
  let path = 'models/repo/' + repo;
  const parts: string[] = [];
  if (opts?.revision)
    parts.push('revision=' + encodeURIComponent(opts.revision));
  if (opts?.returnTo)
    parts.push('returnTo=' + encodeURIComponent(opts.returnTo));
  if (parts.length) path += '?' + parts.join('&');
  return path;
}
const navigationGuards: (() => Promise<boolean>)[] = [];
export function setNavigationGuard(guard: () => Promise<boolean>) {
  navigationGuards.push(guard);
  return () => {
    const index = navigationGuards.indexOf(guard);
    if (index !== -1) navigationGuards.splice(index, 1);
  };
}
export async function canNavigate() {
  for (const guard of [...navigationGuards].reverse()) {
    if (!(await guard())) return false;
  }
  return true;
}
