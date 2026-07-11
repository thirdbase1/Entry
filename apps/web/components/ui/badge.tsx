/**
 * shadcn-style Badge — minimal version (no class-variance-authority
 * dependency in this project, so variants are a plain lookup object
 * instead of a cva() call; same visual output/API shape).
 */
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  destructive: 'border-transparent bg-destructive/15 text-destructive',
  outline: 'text-foreground border-border',
} as const;

export type BadgeVariant = keyof typeof badgeVariants;

export function Badge({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'span'> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium w-fit whitespace-nowrap shrink-0',
        badgeVariants[variant],
        className
      )}
      {...props}
    />
  );
}
