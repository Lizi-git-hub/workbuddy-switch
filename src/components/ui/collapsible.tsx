
import * as React from "react";

import { cn } from "@/lib/utils";

interface CollapsibleContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  contentId: string;
  triggerId: string;
}

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(null);

function useCollapsible(component: string): CollapsibleContextValue {
  const ctx = React.useContext(CollapsibleContext);
  if (!ctx) throw new Error(`<${component}> 必须放在 <Collapsible> 内使用。`);
  return ctx;
}

export interface CollapsibleProps {
  /** 受控开合；不传即非受控（配合 `defaultOpen`）。 */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children?: React.ReactNode;
}

function Collapsible({ open, defaultOpen = false, onOpenChange, className, children }: CollapsibleProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolled;
  const baseId = React.useId();

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const ctx = React.useMemo<CollapsibleContextValue>(
    () => ({ open: isOpen, setOpen, contentId: `${baseId}-content`, triggerId: `${baseId}-trigger` }),
    [isOpen, setOpen, baseId],
  );

  return (
    <CollapsibleContext.Provider value={ctx}>
      <div data-slot="collapsible" data-state={isOpen ? "open" : "closed"} className={cn(className)}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

function CollapsibleTrigger({ className, onClick, ...props }: React.ComponentProps<"button">) {
  const ctx = useCollapsible("CollapsibleTrigger");
  return (
    <button
      type="button"
      data-slot="collapsible-trigger"
      data-state={ctx.open ? "open" : "closed"}
      id={ctx.triggerId}
      aria-expanded={ctx.open}
      aria-controls={ctx.contentId}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) ctx.setOpen(!ctx.open);
      }}
      className={cn("cursor-pointer", className)}
      {...props}
    />
  );
}

function CollapsibleContent({ className, ...props }: React.ComponentProps<"div">) {
  const ctx = useCollapsible("CollapsibleContent");
  return (
    <div
      data-slot="collapsible-content"
      data-state={ctx.open ? "open" : "closed"}
      id={ctx.contentId}
      hidden={!ctx.open}
      className={cn(className)}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
