import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import type { User, Profile, Firm } from '../types';

interface AuthCtx {
  user: User | null;
  profile: Profile | null;
  firm: Firm | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName: string, firmName: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]       = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [firm, setFirm]       = useState<Firm | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadProfile(userId: string) {
    try {
      const { data: prof } = await supabase
        .from('profiles').select('*').eq('id', userId).single();
      setProfile(prof);
      if (prof?.firm_id) {
        const { data: f } = await supabase
          .from('firms').select('*').eq('id', prof.firm_id).single();
        setFirm(f);
      }
    } catch (_) {
      // Profile may not exist yet — that's ok
    }
  }

  useEffect(() => {
    // Check for existing session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email! });
        loadProfile(session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email! });
        loadProfile(session.user.id);
      } else {
        setUser(null); setProfile(null); setFirm(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Sign in directly via Supabase (no backend needed) ─────
  async function signIn(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    if (data.user) {
      setUser({ id: data.user.id, email: data.user.email! });
      await loadProfile(data.user.id);
    }
  }

  // ── Sign up via backend (needed to create firm) ───────────
  async function signUp(email: string, password: string, fullName: string, firmName: string) {
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const res = await fetch(`${apiUrl}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, full_name: fullName, firm_name: firmName }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');

      // Session returned from backend — set it directly
      if (data.session) {
        await supabase.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
      } else {
        // Backend signup worked, now sign in via Supabase directly
        await signIn(email, password);
      }
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('Request timed out. The server may be waking up — please try again.');
      throw err;
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setUser(null); setProfile(null); setFirm(null);
  }

  return (
    <AuthContext.Provider value={{ user, profile, firm, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
