// Reusable presentational primitives.
import type { ComponentChildren } from 'preact';
import { Icon } from '../icons';
import { initials, hueOf, STATUS_META } from '../util';
import type { UserStatus } from '../api';

export function Avatar({ name, email, size = 34 }: { name?: string; email?: string; size?: number }) {
  const h = hueOf(email || name || '?');
  return (
    <span
      class="inline-flex items-center justify-center rounded-full font-semibold text-white shrink-0 select-none"
      style={{
        width: size, height: size, fontSize: size * 0.4,
        background: `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 38) % 360} 60% 42%))`,
      }}
      aria-hidden="true"
    >
      {initials(name, email)}
    </span>
  );
}

export function StatusPill({ status }: { status: UserStatus }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return (
    <span class={`pill ${m.cls}`}>
      <span class={`pill-dot ${m.dot}`} />
      {m.label}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ComponentChildren }) {
  return (
    <header class="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 class="text-[22px] font-semibold tracking-[-0.01em] leading-tight">{title}</h1>
        {subtitle && <p class="text-muted text-[13.5px] mt-1">{subtitle}</p>}
      </div>
      {actions && <div class="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, hint, icon = 'inbox', action }: { title: string; hint?: string; icon?: keyof typeof Icon; action?: ComponentChildren }) {
  const I = Icon[icon];
  return (
    <div class="flex flex-col items-center justify-center text-center py-16 px-6 animate-fade-in">
      <div class="w-12 h-12 rounded-xl surface-subtle bordered flex items-center justify-center text-faint mb-4">
        <I size={22} />
      </div>
      <p class="font-medium text-[15px]">{title}</p>
      {hint && <p class="text-muted text-[13px] mt-1.5 max-w-sm">{hint}</p>}
      {action && <div class="mt-5">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg class="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.4" opacity="0.18" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
    </svg>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="block">
      <span class="label-caps block mb-1.5">{label}</span>
      {children}
      {hint && <span class="block text-[12px] text-faint mt-1.5">{hint}</span>}
    </label>
  );
}

export function SkeletonRows({ rows = 7, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div class="divide-y" style={{ borderColor: 'rgb(var(--border))' }}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} class="flex items-center gap-4 px-4 h-[56px]">
          <div class="skeleton w-9 h-9 rounded-full" />
          <div class="flex-1 grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {Array.from({ length: cols }).map((_, c) => (
              <div key={c} class="skeleton h-3.5" style={{ width: `${50 + ((r + c) % 4) * 12}%` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function StatTileSkeleton() {
  return (
    <div class="card p-4">
      <div class="skeleton h-3 w-20 mb-3" />
      <div class="skeleton h-7 w-14" />
    </div>
  );
}
