import { createContext, useContext } from 'react';

export interface AuthContextValue {
  username: string;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  username: '',
  logout: async () => {},
});

export const useAuth = () => useContext(AuthContext);
