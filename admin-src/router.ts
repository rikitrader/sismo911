// Hash-based router (safe under not_found_handling="none"). Route = #/<slug>.
import { useState, useEffect } from 'preact/hooks';

export function currentRoute(): string {
  const h = location.hash.replace(/^#\/?/, '').trim();
  return h || 'dashboard';
}

export function navigate(slug: string) {
  location.hash = '/' + slug;
}

export function useRoute(): string {
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
