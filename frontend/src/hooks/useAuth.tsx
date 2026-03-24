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
    } catch (_) {}
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email! });
        loadProfile(session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

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

  // ── Sign in — direct Supabase, no backend needed ──────────
  async function signIn(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    if (data.user) {
      setUser({ id: data.user.id, email: data.user.email! });
      await loadProfile(data.user.id);
    }
  }

  // ── Sign up — all direct Supabase, no backend needed ─────
  async function signUp(email: string, password: string, fullName: string, firmName: string) {
    // 1. Create auth user directly via Supabase
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });

    if (signUpError) throw new Error(signUpError.message);
    if (!authData.user) throw new Error('Signup failed. Please try again.');

    // 2. Sign in immediately to get a session
    const { data: sessionData, error: signInError } = await supabase.auth.signInWithPassword({
      email, password,
    });

    if (signInError) throw new Error('Account created! Please sign in.');

    // 3. Create firm directly in Supabase (using authenticated client)
    if (firmName && sessionData.session) {
      const { data: firm } = await supabase
        .from('firms')
        .insert({ name: firmName, plan: 'pro' })
        .select()
        .single();

      if (firm) {
        await supabase
          .from('profiles')
          .update({
            firm_id: (firm as any).id,
            role: 'senior_partner',
            full_name: fullName,
            initials: fullName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2),
          })
          .eq('id', authData.user.id);
      }
    }

    // 4. Load profile
    setUser({ id: authData.user.id, email: authData.user.email! });
    await loadProfile(authData.user.id);
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
