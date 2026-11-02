export const go = (path: string) => {
  window.location.hash = '/' + path;
};
let navigationGuard: (() => Promise<boolean>) | undefined;
export function setNavigationGuard(guard: () => Promise<boolean>) {
  navigationGuard = guard;
  return () => {
    if (navigationGuard === guard) navigationGuard = undefined;
  };
}
export async function canNavigate() {
  return navigationGuard ? navigationGuard() : true;
}
