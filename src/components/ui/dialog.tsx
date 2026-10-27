"use client"

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogContent({
  className,
  children,
  side = "right",
  ...props
}: DialogPrimitive.Popup.Props & { side?: "right" | "left" }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] transition-opacity duration-300 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      {/* A sheet that slides in from the screen edge, and back out the same way on close. */}
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-side={side}
        className={cn(
          "group/dialog fixed inset-y-2 z-50 flex w-[calc(100%-1rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          // Floats 8px off the screen edges, and slides a little past its own width so the
          // shadow is gone too when it is closed.
          side === "right"
            ? "right-2 data-ending-style:translate-x-[calc(100%+1rem)] data-starting-style:translate-x-[calc(100%+1rem)]"
            : "left-2 data-ending-style:-translate-x-[calc(100%+1rem)] data-starting-style:-translate-x-[calc(100%+1rem)]",
          className
        )}
        {...props}
      >
        {children}
        {/* Close sits on the sheet's inner edge — top-left for a right-hand sheet. */}
        <DialogPrimitive.Close
          className="absolute top-4 rounded-md group-data-[side=left]/dialog:right-3 group-data-[side=right]/dialog:left-3 p-1.5 text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label="Close"
        >
          <XIcon className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-none flex-col gap-1 border-b border-border px-5 py-4 group-data-[side=left]/dialog:pr-12 group-data-[side=right]/dialog:pl-12", className)}
      {...props}
    />
  )
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

export { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription }
