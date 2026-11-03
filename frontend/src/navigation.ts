export const go = (path: string) => {
  window.location.hash = '/' + path;
};
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
