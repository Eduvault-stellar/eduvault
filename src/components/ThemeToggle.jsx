"use client";

import { useEffect, useState } from "react";
import { FaMoon, FaSun } from "react-icons/fa6";
import { useThemePreference } from "@/hooks/useThemePreference";

export default function ThemeToggle({ className = "" }) {
	const { isDark, toggleTheme } = useThemePreference();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setMounted(true);
	}, []);

	if (!mounted) {
		return null;
	}

	return (
		<button
			type="button"
			onClick={toggleTheme}
			className={`inline-flex items-center justify-center rounded-full border border-border-subtle bg-surface-muted p-2.5 text-foreground transition-all duration-200 hover:bg-surface hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-stellar-blue/40 ${className}`}
			aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
			aria-pressed={isDark}
			title={isDark ? "Switch to light theme" : "Switch to dark theme"}
		>
			{isDark ? <FaSun className="h-4 w-4" /> : <FaMoon className="h-4 w-4" />}
		</button>
	);
}
