'use client';

/**
 * Standard shadcn-style Collapsible — thin wrapper around
 * @radix-ui/react-collapsible. Added (2026-07-11) specifically to back
 * the new components/ui/tool.tsx (AI Elements' real `Tool` component),
 * which needs genuine open/close state + data-state attributes for its
 * chevron rotation and enter/exit animation.
 */
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';

const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;
const CollapsibleContent = CollapsiblePrimitive.CollapsibleContent;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
