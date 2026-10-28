import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check, Copy, LoaderCircle, MoreHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Badge } from '@/components/ui/badge';
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
} from '@/components/ui/dropdown-menu';
import {
  Empty as EmptyRoot,
  EmptyHeader,
  EmptyTitle,
  EmptyContent,
} from '@/components/ui/empty';
import {
  Field as FieldRoot,
  FieldLabel,
  FieldTitle,
  FieldDescription,
} from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const fieldControls = new Set<unknown>([Input, Textarea, NativeSelect]);

export function Status({ value }: { value: string }) {
  const failed = /failed|degraded|error/i.test(value);
  const ready = /ready|succeeded|complete/i.test(value);
  const pending = /loading|starting|queued|running|unloading/i.test(value);
  return (
    <Badge
      variant={failed ? 'destructive' : ready ? 'default' : 'secondary'}
      className="whitespace-nowrap"
    >
      {pending && (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      )}
      {value}
    </Badge>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <EmptyRoot>
      <EmptyHeader>
        <EmptyTitle role="heading" aria-level={2}>
          {title}
        </EmptyTitle>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </EmptyRoot>
  );
}

// These are route selectors, not tab panels. ToggleGroup supplies roving keyboard
// focus without inventing tabpanel relationships for hash-routed page content.
export function Tabs({
  items,
  value,
  onChange,
  label = 'Views',
}: {
  items: string[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <div className="mb-6 max-w-full overflow-x-auto pb-1">
      <ToggleGroup
        variant="outline"
        value={[value]}
        onValueChange={(values) => {
          if (values.length) onChange(values[0]);
        }}
        aria-label={label}
      >
        {items.map((item) => (
          <ToggleGroupItem key={item} value={item}>
            {item}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function CopyButton({
  value,
  label = 'Copy',
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  const accessible = error
    ? 'Copy failed; select and copy the text'
    : copied
      ? 'Copied'
      : label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={accessible}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setError(false);
              } catch {
                setError(true);
              }
            }}
          />
        }
      >
        {copied ? <Check /> : <Copy />}
        <span className="sr-only" role="status">
          {copied ? 'Copied' : error ? 'Copy failed' : ''}
        </span>
      </TooltipTrigger>
      <TooltipContent>{accessible}</TooltipContent>
    </Tooltip>
  );
}

export function Menu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>{children}</DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Dialog({
  title,
  close,
  children,
  busy = false,
  wide = false,
  editor = false,
  guardChanges = true,
  changed,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  busy?: boolean;
  wide?: boolean;
  editor?: boolean;
  guardChanges?: boolean;
  changed?: boolean;
}) {
  const dirty = useRef(false),
    [discard, setDiscard] = useState(false);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (guardChanges && (changed ?? dirty.current)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [guardChanges, changed]);
  const dismiss = () => {
    if (busy) return;
    if (guardChanges && (changed ?? dirty.current)) setDiscard(true);
    else close();
  };
  return (
    <DialogRoot
      open
      onOpenChange={(open, details) => {
        if (!open) {
          details.cancel();
          dismiss();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(
          'flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg',
          wide && 'sm:max-w-3xl',
          editor &&
            'editor-page h-dvh max-h-dvh max-w-full rounded-none sm:max-w-full',
        )}
        onChangeCapture={(event) => {
          if ((event.target as HTMLElement).closest('form'))
            dirty.current = true;
        }}
        onClickCapture={(event) => {
          if (
            (event.target as HTMLElement).closest(
              'form [aria-pressed], form [role="checkbox"], form [role="switch"], form [role="slider"]',
            )
          )
            dirty.current = true;
        }}
        onKeyDownCapture={(event) => {
          if (
            (event.target as HTMLElement).closest('form [role="slider"]') &&
            ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
          )
            dirty.current = true;
        }}
      >
        <DialogHeader className="dialog-head flex-row items-center justify-between border-b p-5">
          <DialogTitle>{title}</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close dialog"
            disabled={busy}
            onClick={dismiss}
          >
            <X />
          </Button>
        </DialogHeader>
        <div className="dialog-body min-h-0 overflow-y-auto overscroll-contain p-5">
          {children}
        </div>
        <AlertDialog open={discard} onOpenChange={setDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
              <AlertDialogDescription>
                Your changes have not been saved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={close}>
                Discard changes
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </DialogRoot>
  );
}

// Domain-friendly composition of shadcn Field. Associate a direct control with
// its label/hint; compound controls keep their own explicit accessible names.
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId(),
    nodes = Children.toArray(children);
  const direct = nodes.findIndex(
    (node) => isValidElement(node) && fieldControls.has(node.type),
  );
  const control =
    direct >= 0
      ? (nodes[direct] as ReactElement<{
          id?: string;
          'aria-describedby'?: string;
          'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
        }>)
      : null;
  if (control)
    nodes[direct] = cloneElement(control, {
      id: control.props.id || id,
      'aria-describedby': hint
        ? `${id}-hint`
        : control.props['aria-describedby'],
    });
  return (
    <FieldRoot className="mb-4" data-invalid={control?.props['aria-invalid']}>
      {control ? (
        <FieldLabel htmlFor={control.props.id || id}>{label}</FieldLabel>
      ) : (
        <FieldTitle>{label}</FieldTitle>
      )}
      {nodes}
      {hint && <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>}
    </FieldRoot>
  );
}
