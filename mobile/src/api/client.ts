import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import type { MissingPerson, MissingPersonInput, SubmitPersonResponse } from '@/types/api';

const TOKEN_KEY = 'sismo911.session';

const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
export const API_BASE_URL = extra?.apiBaseUrl || 'https://sismo911.com';

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
};

export async function saveSessionToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function getSessionToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function clearSessionToken() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth) {
    const token = await getSessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(String(message));
  }
  return data as T;
}

export function listMissingPersons() {
  return apiFetch<{ persons: MissingPerson[] }>('/api/persons?status=missing');
}

export function submitMissingPerson(input: MissingPersonInput) {
  return apiFetch<SubmitPersonResponse>('/api/persons', {
    method: 'POST',
    body: {
      ...input,
      status: input.status || 'missing',
    },
  });
}

export function healthCheck() {
  return apiFetch<{ ok: boolean; service: string; ts: number }>('/api/health');
}
