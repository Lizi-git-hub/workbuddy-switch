import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 弹窗宽度档位。
 *
 * - `default` = 420px（原型 `.confirm`，二选一确认框用）；
 * - `wide` = 620px（**内容型**弹窗：升级前版本说明这类分组长文本，420 会把每行挤成三四个字）。
 *
 * 为什么做成档位而不是让调用方写 `!max-w-[620px]`：基础样式里已经有 `sm:max-w-[420px]`，
 * 同 variant 同属性叠加时**谁生效取决于 Tailwind 生成顺序**（不是 class 书写顺序），
 * 靠 `!important` 兜底等于把可预测性换成运气。
 */
type DialogWidth = "default" | "wide";

function DialogContent({
  className,
  children,
  showCloseButton = true,
  width = "default",
  /* `flush` = 内距与行距交给调用方（页头 / 可滚正文 / 固定动作条三段式）。
     这类弹窗需要「正文滚动、动作条钉底」，统一 `p-5 + gap-4` 会把三段挤成一段。 */
  flush = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  width?: DialogWidth;
  flush?: boolean;
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-popover data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed left-[50%] top-[6vh] z-50 grid max-h-[calc(100dvh_-_12vh)] w-full max-w-[calc(100%_-_2rem)] -translate-x-1/2 rounded-[16px] border shadow-overlay duration-200",
          width === "wide" ? "sm:max-w-[620px]" : "sm:max-w-[420px]",
          /* `flush` 自己管滚动（三段式：页头 / 可滚正文 / 钉底动作条），别再叠 `overflow-y-auto`
             与它的 `overflow-hidden` 抢同一属性。 */
          flush ? "gap-0 overflow-hidden p-0" : "gap-4 overflow-y-auto p-5",
          className,
        )}
        {...props}
      >        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      /* 原型 `.confirm h3`（`demo.css:597`）：`15px` / `font-weight:640`（不是 shadcn 的18px/600） */
      className={cn("text-[15px] leading-tight font-[640]", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      /* 原型 `.confirm p`（`demo.css:598`）：`12.5px` / `line-height:1.6` / muted */
      className={cn("text-muted-foreground text-[12.5px] leading-relaxed", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
