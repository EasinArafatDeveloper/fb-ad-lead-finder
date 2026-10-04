import { createContext, useContext } from 'react';

/** The logged-in user: me = { user: {id,email,name,role}, workspace: {id,name,limits} } */
export const AuthCtx = createContext({ me: null, setMe: () => {}, logout: () => {} });
export const useAuth = () => useContext(AuthCtx);
export const useIsAdmin = () => useContext(AuthCtx).me?.user.role === 'admin';
