import * as React from 'react';
import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import { cn } from '@/lib/utils';

// Base-mira composition, scoped to the side/bottom drawers used by editors.
const Direction = React.createContext<'right' | 'down'>('down');

function Drawer({
  swipeDirection = 'down',
  ...props
}: Omit<DrawerPrimitive.Root.Props, 'swipeDirection'> & {
  swipeDirection?: 'right' | 'down';
}) {
  return (
    <Direction.Provider value={swipeDirection}>
      <DrawerPrimitive.Root swipeDirection={swipeDirection} {...props} />
    </Direction.Provider>
  );
}

function DrawerContent({
  className,
  children,
  ...props
}: DrawerPrimitive.Popup.Props) {
  const direction = React.useContext(Direction);
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Backdrop
        data-slot="drawer-overlay"
        className="fixed inset-0 z-50 min-h-dvh bg-black/80 opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-300 data-ending-style:opacity-0 data-starting-style:opacity-0 data-swiping:duration-0 supports-backdrop-filter:backdrop-blur-xs"
      />
      <DrawerPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50">
        <DrawerPrimitive.Popup
          data-slot="drawer-popup"
          data-swipe-direction={direction}
          className={cn(
            'pointer-events-auto fixed flex min-h-0 flex-col border bg-popover text-xs/relaxed text-popover-foreground shadow-lg outline-none transition-transform duration-300 data-starting-style:transform-(--closed-transform) data-ending-style:transform-(--closed-transform) data-swiping:duration-0',
            'data-[swipe-direction=right]:inset-y-0 data-[swipe-direction=right]:right-0 data-[swipe-direction=right]:w-[min(36rem,100%)] data-[swipe-direction=right]:[--closed-transform:translateX(100%)] data-[swipe-direction=right]:translate-x-(--drawer-swipe-movement-x)',
            'data-[swipe-direction=down]:inset-x-0 data-[swipe-direction=down]:bottom-0 data-[swipe-direction=down]:max-h-[92dvh] data-[swipe-direction=down]:rounded-t-xl data-[swipe-direction=down]:[--closed-transform:translateY(100%)] data-[swipe-direction=down]:translate-y-(--drawer-swipe-movement-y)',
            className,
          )}
          {...props}
        >
          <DrawerPrimitive.Content className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex shrink-0 flex-col gap-2 border-b p-5', className)}
      {...props}
    />
  );
}
function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn(
        'mt-auto flex shrink-0 justify-end gap-2 border-t p-5',
        className,
      )}
      {...props}
    />
  );
}
function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      className={cn('font-heading text-sm font-medium', className)}
      {...props}
    />
  );
}
function DrawerDescription({
  className,
  ...props
}: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      className={cn('text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
