/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Full 0–100 opacity ramp: the HUD leans on fractional alphas (/8, /12,
      // /35, /45, /55) for hairlines and glows that the default scale omits.
      opacity: Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [String(i), String(i / 100)]),
      ),
      colors: {
        // Cinematic trading-desk palette: deep space, cyan signal, amber risk.
        void: {
          900: '#03040a',
          800: '#060912',
          700: '#0a1020',
          600: '#111a2e',
          500: '#182541',
        },
        signal: {
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63',
        },
        plasma: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },
        bull: '#22c55e',
        bear: '#ef4444',
        caution: '#f59e0b',
        critical: '#f43f5e',
        terminal: '#7dd3fc',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        display: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        orb: '0 0 80px -20px rgba(34,211,238,0.55)',
        node: '0 0 24px -6px rgba(34,211,238,0.45)',
        danger: '0 0 60px -12px rgba(244,63,94,0.65)',
        panel: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 20px 60px -30px rgba(0,0,0,0.9)',
      },
      animation: {
        'spin-slow': 'spin 26s linear infinite',
        'spin-slower': 'spin 44s linear infinite reverse',
        'pulse-ring': 'pulse-ring 2.4s cubic-bezier(0.4,0,0.6,1) infinite',
        scan: 'scan 6s linear infinite',
        flicker: 'flicker 4.5s ease-in-out infinite',
        'rise-in': 'rise-in 0.5s cubic-bezier(0.16,1,0.3,1) both',
      },
      keyframes: {
        'pulse-ring': {
          '0%, 100%': { opacity: '0.55', transform: 'scale(1)' },
          '50%': { opacity: '0.15', transform: 'scale(1.06)' },
        },
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        flicker: {
          '0%, 100%': { opacity: '1' },
          '48%': { opacity: '1' },
          '50%': { opacity: '0.86' },
          '52%': { opacity: '1' },
        },
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      backgroundImage: {
        grid: `linear-gradient(rgba(34,211,238,0.055) 1px, transparent 1px),
               linear-gradient(90deg, rgba(34,211,238,0.055) 1px, transparent 1px)`,
        'radial-void': 'radial-gradient(ellipse at 50% 30%, #0a1020 0%, #03040a 68%)',
      },
      backgroundSize: {
        grid: '46px 46px',
      },
    },
  },
  plugins: [],
};
