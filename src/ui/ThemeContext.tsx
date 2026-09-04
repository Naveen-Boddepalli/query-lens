/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext } from 'react';
import type { ThemeState } from './theme.ts';
import { useTheme } from './theme.ts';

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themeState = useTheme();
  return <ThemeContext value={themeState}>{children}</ThemeContext>;
}


export function useThemeContext(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemeContext must be used within ThemeProvider');
  return ctx;
}
