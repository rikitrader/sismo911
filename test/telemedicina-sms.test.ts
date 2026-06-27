import { describe, it, expect } from 'vitest';
import { twilioReady, twilioFrom, addr, sendText, notifyPatientText } from '../src/lib/sms';

const FULL: any = { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_SMS_FROM: '+15551112222', TWILIO_WHATSAPP_FROM: '+15553334444' };

describe('Twilio config gating', () => {
  it('is not ready when secrets are missing', () => {
    expect(twilioReady({} as any, 'sms')).toBe(false);
    expect(twilioReady({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' } as any, 'sms')).toBe(false); // no From
    expect(twilioReady({ ...FULL, TWILIO_WHATSAPP_FROM: undefined } as any, 'whatsapp')).toBe(false);
  });
  it('is ready per-channel when its From + creds exist', () => {
    expect(twilioReady(FULL, 'sms')).toBe(true);
    expect(twilioReady(FULL, 'whatsapp')).toBe(true);
    expect(twilioFrom(FULL, 'whatsapp')).toBe('+15553334444');
  });
});

describe('channel address shaping', () => {
  it('prefixes whatsapp:, leaves sms bare', () => {
    expect(addr('whatsapp', '+58412')).toBe('whatsapp:+58412');
    expect(addr('sms', '+58412')).toBe('+58412');
  });
});

describe('graceful no-op without secrets', () => {
  it('sendText returns false and never calls the network when unconfigured', async () => {
    await expect(sendText({} as any, '+58412', 'hola', 'sms')).resolves.toBe(false);
    await expect(sendText({} as any, '+58412', 'hola', 'whatsapp')).resolves.toBe(false);
  });
  it('sendText returns false for an empty recipient', async () => {
    await expect(sendText(FULL, '', 'hola', 'sms')).resolves.toBe(false);
  });
  it('notifyPatientText short-circuits both channels with no phone', async () => {
    await expect(notifyPatientText(FULL, '', 'hola')).resolves.toEqual({ whatsapp: false, sms: false });
  });
});
