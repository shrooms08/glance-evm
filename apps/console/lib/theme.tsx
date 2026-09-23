"use client";
/**
 * Dark by default, light supported. The choice is a per-viewer convenience kept in this browser (localStorage); a
 * small inline script in the layout applies it before the first paint, so the page never flashes the other theme.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import type { ThemeName } from "@glance/design";

const KEY = "glance-theme";

export const themeBootScript = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

const ThemeContext = createContext<{ theme: ThemeName; toggle(): void }>({ theme: "dark", toggle() {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>("dark");
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    if (t === "light" || t === "dark") setTheme(t);
  }, []);
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: ThemeName = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // private window: the choice lasts for this page only
      }
      return next;
    });
  }, []);
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
