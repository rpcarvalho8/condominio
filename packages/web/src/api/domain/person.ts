export type Person = {
  id: string;
  userId: string | null;
  name: string;
  nif: string | null;
  email: string;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
