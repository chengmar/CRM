import { BITABLE_URL_FIELD_NAMES } from "./field-mapping.js";

export function isUrlFieldConversionError(error: unknown): boolean {
  return /(?:code=1254068|URLFieldConvFail)/i.test(String(error));
}

export function isPhoneFieldConversionError(error: unknown): boolean {
  return /(?:code=1254072|convert phone field)/i.test(String(error));
}

export function withoutUrlFields<T extends { fields: Record<string, unknown> }>(record: T): T {
  const fields = { ...record.fields };
  for (const field of BITABLE_URL_FIELD_NAMES) delete fields[field];
  return { ...record, fields };
}

export function withoutPhoneFields<T extends { fields: Record<string, unknown> }>(record: T): T {
  const fields = { ...record.fields };
  delete fields.whatsapp;
  return { ...record, fields };
}
