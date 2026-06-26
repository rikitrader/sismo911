export type MissingPersonStatus = 'missing' | 'found_safe' | 'found_deceased' | 'unknown';

export interface MissingPerson {
  id: string;
  full_name: string;
  age: number | null;
  sex: string | null;
  last_seen: string | null;
  status: MissingPersonStatus;
  photo_url: string | null;
  created_ms: number;
  updated_ms: number;
}

export interface MissingPersonInput {
  full_name: string;
  age?: number | null;
  sex?: string | null;
  last_seen?: string | null;
  last_seen_lat?: number | null;
  last_seen_lon?: number | null;
  contact_phone?: string | null;
  notes?: string | null;
  reported_by?: string | null;
  status?: MissingPersonStatus;
}

export interface SubmitPersonResponse {
  ok: true;
  id: string;
  review: 'pending';
  message: string;
}
