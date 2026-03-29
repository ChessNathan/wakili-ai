import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import type { User, Profile, Firm } from '../types';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface Ctx {
  user: User | null;
  profile: Profile | null;
  firm: Firm | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName: string, firmName: string) => Promise<void>;
  signUpStaff: (email: string, password: string, fullName: string, firmId: string, role: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]       = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [firm, setFirm]       = useState<Firm | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadProfile(uid: string) {
    try {
      const { data: p } = await supabase.from('profiles').select('*').eq('id', uid).single();
      setProfile(p);
      if (p?.firm_id) {
        const { data: f } = await supabase.from('firms').select('*').eq('id', p.firm_id).single();
        setFirm(f);
      } else {
        setFirm(null);
      }
    } catch (_) {}
  }

  async function refreshProfile() { if (user) await loadProfile(user.id); }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email! });
        loadProfile(session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email! });
        loadProfile(session.user.id);
      } else {
        setUser(null); setProfile(null); setFirm(null);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    if (data.user) {
      setUser({ id: data.user.id, email: data.user.email! });
      await loadProfile(data.user.id);
    }
  }

  // Founder signup — creates a new firm
  async function signUp(email: string, password: string, fullName: string, firmName: string) {
    const res = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, full_name: fullName, firm_name: firmName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');

    // Set session from the response
    if (data.session) {
      await supabase.auth.setSession({
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    }
    setUser({ id: data.user.id, email: data.user.email });
    await loadProfile(data.user.id);
  }

  // Staff signup — joins an existing firm using firm_id
  async function signUpStaff(email: string, password: string, fullName: string, firmId: string, role: string) {
    const res = await fetch(`${BASE}/api/auth/signup-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, full_name: fullName, firm_id: firmId, role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');

    if (data.session) {
      await supabase.auth.setSession({
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    }
    setUser({ id: data.user.id, email: data.user.email });
    await loadProfile(data.user.id);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setUser(null); setProfile(null); setFirm(null);
  }

  return (
    <AuthCtx.Provider value={{ user, profile, firm, loading, signIn, signUp, signUpStaff, signOut, refreshProfile }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
