import { useEffect } from 'react';
import { useConfirmation } from './use-confirmation';
import { setNavigationGuard } from '@/navigation';

export function useUnsavedChanges(changed: boolean, busy = false) {
  const { confirm, confirmation } = useConfirmation();
  useEffect(() => {
    if (!changed && !busy) return;
    const clear = setNavigationGuard(() =>
      busy ? Promise.resolve(false) : confirm('Discard unsaved changes?'),
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clear();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [changed, busy, confirm]);
  return confirmation;
}
