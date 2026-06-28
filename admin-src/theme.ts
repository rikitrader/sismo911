// Theme: persisted in localStorage, falls back to prefers-color-scheme.
import { useState, useCallback, useEffect } from 'preact/hooks';

const KEY = 'sismo-admin-theme';

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function apply(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
  try { localStorage.setItem(KEY, dark ? 'dark' : 'light'); } catch {}
}

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(isDark());
  const toggle = useCallback(() => {
    const next = !isDark();
    apply(next);
    setDark(next);
  }, []);
  useEffect(() => {
    // React to OS changes only when the user hasn't explicitly chosen.
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (localStorage.getItem(KEY)) return;
      document.documentElement.classList.toggle('dark', mq.matches);
      setDark(mq.matches);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return [dark, toggle];
}
