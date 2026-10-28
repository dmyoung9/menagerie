import {useEffect, useRef, useState} from 'react';
import {AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction} from '@/components/ui/alert-dialog';

export function useConfirmation() {
  const [description, setDescription] = useState('');
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(() => () => pending.current?.(false), []);
  const finish = (accepted: boolean) => {pending.current?.(accepted); pending.current = null; setDescription('');};
  const confirm = (message: string) => new Promise<boolean>(resolve => {
    pending.current?.(false);
    pending.current = resolve;
    setDescription(message);
  });
  const confirmation = <AlertDialog open={!!description} onOpenChange={open => {if (!open) finish(false);}}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Confirm change</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel onClick={() => finish(false)}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => finish(true)}>Continue</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
  return {confirm, confirmation};
}
