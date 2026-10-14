"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A dropdown the app actually draws.
 *
 * The panes used bare `<select>` for years, and its popup is the one part of the
 * DOM no stylesheet reaches: the list is painted by the OS, so on Windows a
 * carefully themed row opened onto a blue system menu with square corners and no
 * padding. Radix's select renders the list as real elements, which is what makes
 * the trigger, the list, the hover state and the checkmark obey the same tokens as
 * everything around them.
 *
 * `@radix-ui/react-select` was already a dependency (package.json) — only the
 * wrapper was missing.
 *
 * Sizes are pinned to the panes' 12px rows rather than the shadcn defaults (h-9,
 * text-sm): these live inside a 16px-padded inspector next to 12px slider labels,
 * so a taller control would break the rhythm it was added to fix.
 */

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
	React.ComponentRef<typeof SelectPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { placeholder?: string }
>(({ className, placeholder, ...props }, ref) => (
	<SelectPrimitive.Trigger
		ref={ref}
		data-slot="select-trigger"
		className={cn(
			"flex h-8 w-full items-center justify-between gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface-hi)] px-2.5 text-[12px] text-[var(--fg)] outline-hidden transition-colors",
			"hover:border-[var(--border-hi)]",
			"focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
			"data-[placeholder]:text-[var(--muted)]",
			"disabled:cursor-not-allowed disabled:opacity-50",
			className,
		)}
		{...props}
	>
		<SelectPrimitive.Value placeholder={placeholder} />
		<SelectPrimitive.Icon asChild>
			<ChevronDown className="size-3.5 shrink-0 text-[var(--muted)]" />
		</SelectPrimitive.Icon>
	</SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

const SelectContent = React.forwardRef<
	React.ComponentRef<typeof SelectPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
	<SelectPrimitive.Portal>
		<SelectPrimitive.Content
			ref={ref}
			data-slot="select-content"
			position={position}
			sideOffset={4}
			className={cn(
				"z-50 max-h-72 overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface-hi)] p-1 text-[var(--fg)] shadow-md outline-hidden",
				// `popper` sizes the list to the trigger so a long label cannot make the
				// menu jump wider than the row it belongs to.
				position === "popper" && "w-[var(--radix-select-trigger-width)] min-w-[8rem]",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.Viewport className="p-0">{children}</SelectPrimitive.Viewport>
		</SelectPrimitive.Content>
	</SelectPrimitive.Portal>
));
SelectContent.displayName = "SelectContent";

const SelectItem = React.forwardRef<
	React.ComponentRef<typeof SelectPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
	<SelectPrimitive.Item
		ref={ref}
		data-slot="select-item"
		className={cn(
			"relative flex cursor-default select-none items-center rounded-[6px] py-1.5 pr-2 pl-6 text-[12px] text-[var(--fg)] outline-hidden",
			"data-[highlighted]:bg-[var(--surface-1)]",
			// The checked row wears the mint accent, the same one the sliders fill with,
			// so "this is the current value" reads the same way across the pane.
			"data-[state=checked]:bg-[var(--accent-soft)] data-[state=checked]:text-[var(--accent-on)]",
			"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
			className,
		)}
		{...props}
	>
		<span className="absolute left-1.5 flex size-3.5 items-center justify-center">
			<SelectPrimitive.ItemIndicator>
				<Check className="size-3.5 text-[var(--accent)]" />
			</SelectPrimitive.ItemIndicator>
		</span>
		<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
	</SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";

export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue };
