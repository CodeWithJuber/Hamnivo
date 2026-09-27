export interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

/** Stands in for your user database. */
export const USERS: readonly User[] = [
  { id: 'user_1001', name: 'Ayesha Khan', email: 'ayesha@example.com', emailVerified: true },
  { id: 'user_1002', name: 'Omar Farooq', email: 'omar@example.com', emailVerified: false },
];
