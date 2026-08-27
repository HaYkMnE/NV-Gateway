export default {
  content: ['./src/renderer/**/*.{js,jsx,ts,tsx,html}'],
  safelist: ['glow-red'],
  theme: {
    extend: {
      colors: {
        'bg-core': '#060706',
        'bg-surface': '#0D110E',
        'border-hard': '#1A221C',
        'border-soft': '#2A322D',
        'accent-neon': '#59FF00',
        'accent-cyan': '#00FFD1',
        'text-primary': '#F0F4F1',
        'text-muted': '#809285',
        bg: '#060706',
        surface: '#0D110E',
        border: '#1A221C',
        nvidia: '#76B900',
        textMain: '#F0F4F1',
        textMuted: '#809285',
        error: '#FF3333',
        warning: '#FACC15',
        success: '#59FF00',   // matches accent-neon — for "Free Endpoint" badge
        info:    '#00FFD1',   // matches accent-cyan — for "Downloadable" badge
      },
      boxShadow: {
        'glow-neon': '0 0 24px rgba(89, 255, 0, 0.2)',
        'glow-cyan': '0 0 24px rgba(0, 255, 209, 0.2)',
        'glow-neon-strong': '0 0 12px rgba(89, 255, 0, 0.8)',
      },
      fontFamily: { sans: ['Outfit','Segoe UI','Arial','sans-serif'], mono: ['JetBrains Mono','Cascadia Mono','Consolas','monospace'] }
    }
  },
  plugins: [],
}
