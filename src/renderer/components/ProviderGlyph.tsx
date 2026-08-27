import React from 'react';

export interface ProviderInfo {
  id: string;
  name: string;
  color: string;
  glowColor: string;
  borderAccent: string;
  bgTint: string;
  tagBg: string;
  tagText: string;
}

export const providerRegistry: Record<string, ProviderInfo> = {
  '01-ai': {
    id: '01-ai',
    name: '01.AI',
    color: '#00D084',
    glowColor: 'rgba(0, 208, 132, 0.35)',
    borderAccent: '#00D084',
    bgTint: 'rgba(0, 208, 132, 0.10)',
    tagBg: 'rgba(0, 208, 132, 0.15)',
    tagText: '#6EE7B7',
  },
  adept: {
    id: 'adept',
    name: 'Adept',
    color: '#00F0FF',
    glowColor: 'rgba(0, 240, 255, 0.35)',
    borderAccent: '#00F0FF',
    bgTint: 'rgba(0, 240, 255, 0.10)',
    tagBg: 'rgba(0, 240, 255, 0.15)',
    tagText: '#67E8F9',
  },
  ai21labs: {
    id: 'ai21labs',
    name: 'AI21 Labs',
    color: '#6366F1',
    glowColor: 'rgba(99, 102, 241, 0.35)',
    borderAccent: '#6366F1',
    bgTint: 'rgba(99, 102, 241, 0.10)',
    tagBg: 'rgba(99, 102, 241, 0.15)',
    tagText: '#A5B4FC',
  },
  aisingapore: {
    id: 'aisingapore',
    name: 'AI Singapore',
    color: '#EF4444',
    glowColor: 'rgba(239, 68, 68, 0.35)',
    borderAccent: '#EF4444',
    bgTint: 'rgba(239, 68, 68, 0.10)',
    tagBg: 'rgba(239, 68, 68, 0.15)',
    tagText: '#FCA5A5',
  },
  baai: {
    id: 'baai',
    name: 'BAAI',
    color: '#1890FF',
    glowColor: 'rgba(24, 144, 255, 0.35)',
    borderAccent: '#1890FF',
    bgTint: 'rgba(24, 144, 255, 0.10)',
    tagBg: 'rgba(24, 144, 255, 0.15)',
    tagText: '#93C5FD',
  },
  bigcode: {
    id: 'bigcode',
    name: 'BigCode',
    color: '#F59E0B',
    glowColor: 'rgba(245, 158, 11, 0.35)',
    borderAccent: '#F59E0B',
    bgTint: 'rgba(245, 158, 11, 0.10)',
    tagBg: 'rgba(245, 158, 11, 0.15)',
    tagText: '#FDE68A',
  },
  databricks: {
    id: 'databricks',
    name: 'Databricks',
    color: '#FF3621',
    glowColor: 'rgba(255, 54, 33, 0.35)',
    borderAccent: '#FF3621',
    bgTint: 'rgba(255, 54, 33, 0.10)',
    tagBg: 'rgba(255, 54, 33, 0.15)',
    tagText: '#FCA5A5',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    color: '#4D6BFE',
    glowColor: 'rgba(77, 107, 254, 0.35)',
    borderAccent: '#4D6BFE',
    bgTint: 'rgba(77, 107, 254, 0.10)',
    tagBg: 'rgba(77, 107, 254, 0.15)',
    tagText: '#93C5FD',
  },
  google: {
    id: 'google',
    name: 'Google',
    color: '#4285F4',
    glowColor: 'rgba(66, 133, 244, 0.35)',
    borderAccent: '#4285F4',
    bgTint: 'rgba(66, 133, 244, 0.10)',
    tagBg: 'rgba(66, 133, 244, 0.15)',
    tagText: '#93C5FD',
  },
  ibm: {
    id: 'ibm',
    name: 'IBM',
    color: '#0F62FE',
    glowColor: 'rgba(15, 98, 254, 0.35)',
    borderAccent: '#0F62FE',
    bgTint: 'rgba(15, 98, 254, 0.10)',
    tagBg: 'rgba(15, 98, 254, 0.15)',
    tagText: '#8AB4F8',
  },
  meta: {
    id: 'meta',
    name: 'Meta',
    color: '#0081FB',
    glowColor: 'rgba(0, 129, 251, 0.35)',
    borderAccent: '#0081FB',
    bgTint: 'rgba(0, 129, 251, 0.10)',
    tagBg: 'rgba(0, 129, 251, 0.15)',
    tagText: '#60A5FA',
  },
  microsoft: {
    id: 'microsoft',
    name: 'Microsoft',
    color: '#00A4EF',
    glowColor: 'rgba(0, 164, 239, 0.35)',
    borderAccent: '#00A4EF',
    bgTint: 'rgba(0, 164, 239, 0.10)',
    tagBg: 'rgba(0, 164, 239, 0.15)',
    tagText: '#7DD3FC',
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    color: '#FA2C5B',
    glowColor: 'rgba(250, 44, 91, 0.35)',
    borderAccent: '#FA2C5B',
    bgTint: 'rgba(250, 44, 91, 0.10)',
    tagBg: 'rgba(250, 44, 91, 0.15)',
    tagText: '#F472B6',
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    color: '#FF7000',
    glowColor: 'rgba(255, 112, 0, 0.35)',
    borderAccent: '#FF7000',
    bgTint: 'rgba(255, 112, 0, 0.10)',
    tagBg: 'rgba(255, 112, 0, 0.15)',
    tagText: '#FDBA74',
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot AI',
    color: '#3B82F6',
    glowColor: 'rgba(59, 130, 246, 0.35)',
    borderAccent: '#3B82F6',
    bgTint: 'rgba(59, 130, 246, 0.10)',
    tagBg: 'rgba(59, 130, 246, 0.15)',
    tagText: '#93C5FD',
  },
  'nv-mistralai': {
    id: 'nv-mistralai',
    name: 'NVIDIA / Mistral',
    color: '#76B900',
    glowColor: 'rgba(118, 185, 0, 0.35)',
    borderAccent: '#76B900',
    bgTint: 'rgba(118, 185, 0, 0.10)',
    tagBg: 'rgba(118, 185, 0, 0.15)',
    tagText: '#9FE516',
  },
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA',
    color: '#76B900',
    glowColor: 'rgba(118, 185, 0, 0.35)',
    borderAccent: '#76B900',
    bgTint: 'rgba(118, 185, 0, 0.10)',
    tagBg: 'rgba(118, 185, 0, 0.15)',
    tagText: '#9FE516',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    color: '#10A37F',
    glowColor: 'rgba(16, 163, 127, 0.35)',
    borderAccent: '#10A37F',
    bgTint: 'rgba(16, 163, 127, 0.10)',
    tagBg: 'rgba(16, 163, 127, 0.15)',
    tagText: '#6EE7B7',
  },
  poolside: {
    id: 'poolside',
    name: 'Poolside',
    color: '#06B6D4',
    glowColor: 'rgba(6, 182, 212, 0.35)',
    borderAccent: '#06B6D4',
    bgTint: 'rgba(6, 182, 212, 0.10)',
    tagBg: 'rgba(6, 182, 212, 0.15)',
    tagText: '#67E8F9',
  },
  rakuten: {
    id: 'rakuten',
    name: 'Rakuten',
    color: '#BF0000',
    glowColor: 'rgba(191, 0, 0, 0.35)',
    borderAccent: '#BF0000',
    bgTint: 'rgba(191, 0, 0, 0.10)',
    tagBg: 'rgba(191, 0, 0, 0.15)',
    tagText: '#FCA5A5',
  },
  snowflake: {
    id: 'snowflake',
    name: 'Snowflake',
    color: '#29B5E8',
    glowColor: 'rgba(41, 181, 232, 0.35)',
    borderAccent: '#29B5E8',
    bgTint: 'rgba(41, 181, 232, 0.10)',
    tagBg: 'rgba(41, 181, 232, 0.15)',
    tagText: '#7DD3FC',
  },
  stepfun: {
    id: 'stepfun',
    name: 'StepFun',
    color: '#00C08B',
    glowColor: 'rgba(0, 192, 139, 0.35)',
    borderAccent: '#00C08B',
    bgTint: 'rgba(0, 192, 139, 0.10)',
    tagBg: 'rgba(0, 192, 139, 0.15)',
    tagText: '#6EE7B7',
  },
  upstage: {
    id: 'upstage',
    name: 'Upstage',
    color: '#8B5CF6',
    glowColor: 'rgba(139, 92, 246, 0.35)',
    borderAccent: '#8B5CF6',
    bgTint: 'rgba(139, 92, 246, 0.10)',
    tagBg: 'rgba(139, 92, 246, 0.15)',
    tagText: '#C4B5FD',
  },
  writer: {
    id: 'writer',
    name: 'Writer',
    color: '#EC4899',
    glowColor: 'rgba(236, 72, 153, 0.35)',
    borderAccent: '#EC4899',
    bgTint: 'rgba(236, 72, 153, 0.10)',
    tagBg: 'rgba(236, 72, 153, 0.15)',
    tagText: '#F472B6',
  },
  'z-ai': {
    id: 'z-ai',
    name: 'Z.ai',
    color: '#3875FF',
    glowColor: 'rgba(56, 117, 255, 0.35)',
    borderAccent: '#3875FF',
    bgTint: 'rgba(56, 117, 255, 0.10)',
    tagBg: 'rgba(56, 117, 255, 0.15)',
    tagText: '#93C5FD',
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen',
    color: '#8054FF',
    glowColor: 'rgba(128, 84, 255, 0.35)',
    borderAccent: '#8054FF',
    bgTint: 'rgba(128, 84, 255, 0.10)',
    tagBg: 'rgba(128, 84, 255, 0.15)',
    tagText: '#C4B5FD',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    color: '#D97706',
    glowColor: 'rgba(217, 119, 6, 0.35)',
    borderAccent: '#D97706',
    bgTint: 'rgba(217, 119, 6, 0.10)',
    tagBg: 'rgba(217, 119, 6, 0.15)',
    tagText: '#FCD34D',
  },
  default: {
    id: 'default',
    name: 'AI Engine',
    color: '#59FF00',
    glowColor: 'rgba(89, 255, 0, 0.25)',
    borderAccent: '#59FF00',
    bgTint: 'rgba(89, 255, 0, 0.08)',
    tagBg: 'rgba(89, 255, 0, 0.12)',
    tagText: '#86EFAC',
  },
};

const providerAliasMap: Record<string, string> = {
  '01-ai': '01-ai',
  '01ai': '01-ai',
  adept: 'adept',
  ai21labs: 'ai21labs',
  ai21: 'ai21labs',
  aisingapore: 'aisingapore',
  baai: 'baai',
  'b-aai': 'baai',
  bigcode: 'bigcode',
  databricks: 'databricks',
  deepseek: 'deepseek',
  'deepseek-ai': 'deepseek',
  google: 'google',
  ibm: 'ibm',
  meta: 'meta',
  microsoft: 'microsoft',
  minimax: 'minimax',
  minimaxai: 'minimax',
  'minimax-ai': 'minimax',
  mistral: 'mistral',
  'mistral-ai': 'mistral',
  mistralai: 'mistral',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  'moonshot-ai': 'moonshot',
  'nv-mistralai': 'nv-mistralai',
  nvidia: 'nvidia',
  openai: 'openai',
  poolside: 'poolside',
  rakuten: 'rakuten',
  snowflake: 'snowflake',
  stepfun: 'stepfun',
  'stepfun-ai': 'stepfun',
  upstage: 'upstage',
  writer: 'writer',
  'z-ai': 'z-ai',
  zai: 'z-ai',
  zhipu: 'z-ai',
  'zhipu-ai': 'z-ai',
  qwen: 'qwen',
  alibaba: 'qwen',
  'alibaba-qwen': 'qwen',
  anthropic: 'anthropic',
};

export function resolveProvider(slugOrId?: string | null): ProviderInfo {
  if (!slugOrId) return providerRegistry.default;
  const raw = slugOrId.toLowerCase().trim();
  const slug = raw.includes('/') ? raw.split('/')[0] : raw;
  const canonicalKey = providerAliasMap[slug] || (providerRegistry[slug] ? slug : null);
  if (canonicalKey && providerRegistry[canonicalKey]) {
    return providerRegistry[canonicalKey];
  }
  return {
    ...providerRegistry.default,
    id: slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
  };
}

export interface ProviderGlyphProps {
  provider?: string | null;
  size?: number;
  className?: string;
  color?: string;
  glow?: boolean;
}

export const ProviderGlyph: React.FC<ProviderGlyphProps> = ({
  provider,
  size = 20,
  className = '',
  color,
  glow = false,
}) => {
  const info = resolveProvider(provider);
  const fill = color || info.color;

  const renderPath = () => {
    switch (info.id) {
      case '01-ai':
        return (
          <g>
            <path d="M7 4C4.24 4 2 6.24 2 9v6c0 2.76 2.24 5 5 5s5-2.24 5-5V9c0-2.76-2.24-5-5-5zm2 11c0 1.1-.9 2-2 2s-2-.9-2-2V9c0-1.1.9-2 2-2s2 .9 2 2v6z" />
            <path d="M15.5 4.5h2.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1zm-2.2 3.8a1 1 0 0 1 1.4-1.4l1.8 1.8a1 1 0 0 1-1.4 1.4l-1.8-1.8z" />
            <circle cx="21" cy="18" r="1.5" />
          </g>
        );

      case 'adept':
        return (
          <path d="M12 2.5L2 19.5h5.2l2.3-4.5h5l2.3 4.5H22L12 2.5zm0 5.2l1.6 3.3h-3.2L12 7.7z" />
        );

      case 'ai21labs':
        return (
          <g>
            <path d="M3 6.5C3 4.57 4.57 3 6.5 3h3C11.43 3 13 4.57 13 6.5c0 1.63-1.04 2.87-2.12 3.82L7.3 13H13v3H3v-2.5l5.2-4.3C9.1 8.4 10 7.6 10 6.5 10 5.67 9.33 5 8.5 5h-2C5.67 5 5 5.67 5 6.5H3z" />
            <path d="M16 3h2.5C19.88 3 21 4.12 21 5.5v13c0 1.38-1.12 2.5-2.5 2.5H16a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm2 15h.5c.28 0 .5-.22.5-.5v-11c0-.28-.22-.5-.5-.5H18v12z" />
          </g>
        );

      case 'aisingapore':
        return (
          <g>
            <path d="M12 2L3 6.5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12v-6L12 2zm0 2.24l7 3.5v5.26c0 4.45-3 8.62-7 9.75-4-1.13-7-5.3-7-9.75V7.74l7-3.5z" />
            <path d="M9 10.5h6v2H9zm2 3h2v4h-2z" />
            <circle cx="12" cy="8" r="1.3" />
          </g>
        );

      case 'baai':
        return (
          <g>
            <path d="M3 4h8c2.8 0 5 2.2 5 5 0 1.5-.7 2.9-1.8 3.8C15.5 13.7 17 15.7 17 18c0 2.8-2.2 5-5 5H3V4zm4 4v3.5h4c.8 0 1.5-.7 1.5-1.5 0-.8-.7-1.5-1.5-1.5H7zm0 7.5V19h4.5c.8 0 1.5-.7 1.5-1.5 0-.8-.7-1.5-1.5-1.5H7z" />
            <path d="M18 4h3v19h-3z" />
          </g>
        );

      case 'bigcode':
        return (
          <g>
            <path d="M8.5 6L2.5 12l6 6 1.4-1.4L5.3 12l4.6-4.6L8.5 6zm7 0l-1.4 1.4 4.6 4.6-4.6 4.6 1.4 1.4 6-6-6-6z" />
            <path d="M12 6.5l1.3 3.5 3.5 1.3-3.5 1.3L12 16.1l-1.3-3.5-3.5-1.3 3.5-1.3L12 6.5z" />
          </g>
        );

      case 'databricks':
        return (
          <path d="M12 2L1 8.2v7.6L12 22l11-6.2V8.2L12 2zm0 3.2l7.5 4.2-7.5 4.2-7.5-4.2L12 5.2zm-8 4.6l7 3.9v3.9l-7-3.9V9.8zm9 7.8v-3.9l7-3.9v3.9l-7 3.9z" />
        );

      case 'deepseek':
        return (
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 2.5c3.2 0 5.98 1.94 7.15 4.74-1.53.86-3.48 1.46-5.65 1.66-2.95.27-5.5-.32-7.18-1.56C7.62 6.74 9.64 4.5 12 4.5zm-8 7.5c0-1.35.32-2.63.89-3.77 1.76 1.34 4.57 2.01 7.76 1.72 2.64-.24 5-.99 6.78-2.05.37.81.57 1.71.57 2.6 0 4.14-3.36 7.5-7.5 7.5-3.08 0-5.74-1.86-6.9-4.5.25.04.51.06.78.06 1.8 0 3.39-.75 4.5-1.95-1.86-.06-3.47-.99-4.38-2.4-.4.07-.8.11-1.2.11-.27 0-.54-.02-.8-.07z" />
        );

      case 'google':
        return (
          <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
        );

      case 'ibm':
        return (
          <g>
            <rect x="2" y="3" width="5" height="1.5" />
            <rect x="9" y="3" width="6" height="1.5" />
            <rect x="17" y="3" width="5" height="1.5" />
            <rect x="2" y="5.5" width="5" height="1.5" />
            <rect x="9" y="5.5" width="6" height="1.5" />
            <rect x="17" y="5.5" width="2" height="1.5" />
            <rect x="20" y="5.5" width="2" height="1.5" />
            <rect x="3.5" y="8" width="2" height="1.5" />
            <rect x="9" y="8" width="6" height="1.5" />
            <rect x="17" y="8" width="2" height="1.5" />
            <rect x="20" y="8" width="2" height="1.5" />
            <rect x="3.5" y="10.5" width="2" height="1.5" />
            <rect x="9" y="10.5" width="5" height="1.5" />
            <rect x="17" y="10.5" width="5" height="1.5" />
            <rect x="3.5" y="13" width="2" height="1.5" />
            <rect x="9" y="13" width="5" height="1.5" />
            <rect x="17" y="13" width="2" height="1.5" />
            <rect x="20" y="13" width="2" height="1.5" />
            <rect x="3.5" y="15.5" width="2" height="1.5" />
            <rect x="9" y="15.5" width="6" height="1.5" />
            <rect x="17" y="15.5" width="2" height="1.5" />
            <rect x="20" y="15.5" width="2" height="1.5" />
            <rect x="2" y="18" width="5" height="1.5" />
            <rect x="9" y="18" width="6" height="1.5" />
            <rect x="17" y="18" width="2" height="1.5" />
            <rect x="20" y="18" width="2" height="1.5" />
            <rect x="2" y="20.5" width="5" height="1.5" />
            <rect x="9" y="20.5" width="6" height="1.5" />
            <rect x="17" y="20.5" width="5" height="1.5" />
          </g>
        );

      case 'meta':
        return (
          <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
        );

      case 'microsoft':
        return (
          <g>
            <rect x="2" y="2" width="9" height="9" />
            <rect x="13" y="2" width="9" height="9" />
            <rect x="2" y="13" width="9" height="9" />
            <rect x="13" y="13" width="9" height="9" />
          </g>
        );

      case 'minimax':
        return (
          <path d="M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997" />
        );

      case 'mistral':
        return (
          <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
        );

      case 'moonshot':
        return (
          <g>
            <path d="M12.3 2a10 10 0 0 0 0 20 10 10 0 0 1 0-20z" />
            <path d="M16.5 5.5l.9 2 2.2.3-1.6 1.5.4 2.2-1.9-1-1.9 1 .4-2.2-1.6-1.5 2.2-.3.9-2z" />
          </g>
        );

      case 'nv-mistralai':
        return (
          <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
        );

      case 'nvidia':
        return (
          <path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z" />
        );

      case 'openai':
        return (
          <path d="M21.5 10.2a5.5 5.5 0 0 0-.5-4.4 5.6 5.6 0 0 0-4.6-2.8 5.7 5.7 0 0 0-2.3.5A5.6 5.6 0 0 0 9.8 2a5.5 5.5 0 0 0-5.2 3.8 5.6 5.6 0 0 0-3 2.2 5.5 5.5 0 0 0-.1 5.3 5.6 5.6 0 0 0 .5 4.4 5.6 5.6 0 0 0 4.6 2.8c.8 0 1.5-.2 2.3-.5a5.6 5.6 0 0 0 4.3 1.5 5.5 5.5 0 0 0 5.2-3.8 5.6 5.6 0 0 0 3-2.2 5.5 5.5 0 0 0 .1-5.3zm-8.8 11.2a4 4 0 0 1-2.4-.8l3.1-1.8a.8.8 0 0 0 .4-.7v-4.4l1.3.8v3.6a4.1 4.1 0 0 1-2.4 3.3zm-7.6-3.3a4 4 0 0 1-.8-2.4l3.1 1.8c.2.1.5.1.7 0l3.8-2.2v1.5l-3.1 1.8a4.1 4.1 0 0 1-3.7-.5zm-1.8-7.9a4 4 0 0 1 1.6-1.9v3.6c0 .3.2.5.4.7l3.8 2.2-1.3.8-3.1-1.8a4.1 4.1 0 0 1-1.4-3.6zm13.1 2.4-3.8-2.2 1.3-.8 3.1 1.8a4.1 4.1 0 0 1 1.4 3.6 4 4 0 0 1-1.6 1.9v-3.6a.8.8 0 0 0-.4-.7zm1.8-3.5-3.1-1.8a4.1 4.1 0 0 1 3.7.5 4 4 0 0 1 .8 2.4l-3.1-1.8a.8.8 0 0 0-.7 0zm-8.6-4.5a4 4 0 0 1 2.4.8l-3.1 1.8a.8.8 0 0 0-.4.7v4.4l-1.3-.8V7.2a4.1 4.1 0 0 1 2.4-3.3zm.4 5.9 2.2 1.3v2.6l-2.2 1.3-2.2-1.3v-2.6z" />
        );

      case 'poolside':
        return (
          <g>
            <path d="M2 7.5c2.5 0 3.5-1.5 6-1.5s3.5 1.5 6 1.5 3.5-1.5 6-1.5 2 1 2.5 1.5v3c-1.5-.8-3-1.5-5-1.5s-3.5 1.5-6 1.5-3.5-1.5-6-1.5c-2 0-3 1-3.5 1.5v-3z" />
            <path d="M2 14.5c2.5 0 3.5-1.5 6-1.5s3.5 1.5 6 1.5 3.5-1.5 6-1.5 2 1 2.5 1.5v3c-1.5-.8-3-1.5-5-1.5s-3.5 1.5-6 1.5-3.5-1.5-6-1.5c-2 0-3 1-3.5 1.5v-3z" />
          </g>
        );

      case 'rakuten':
        return (
          <g>
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" />
            <path d="M8 6.5h4.6c2.2 0 3.7 1.3 3.7 3.2 0 1.5-.9 2.6-2.2 3l2.4 4.8h-2.5l-2.1-4.4h-1.9v4.4H8V6.5zm2 4.8h2.4c1 0 1.7-.5 1.7-1.4 0-.9-.7-1.4-1.7-1.4H10v2.8z" />
          </g>
        );

      case 'snowflake':
        return (
          <path d="M13 2.05v3.13l2.25-1.3 1 1.73-2.25 1.3 2.7 1.56-.75 2.1-2.95-.5v2.93h3.4v2h-3.4v2.93l2.95-.5.75 2.1-2.7 1.56 2.25 1.3-1 1.73L13 18.82v3.13h-2v-3.13l-2.25 1.3-1-1.73 2.25-1.3-2.7-1.56.75-2.1 2.95.5v-2.93H7.6v-2h3.4V7.07l-2.95.5-.75-2.1 2.7-1.56-2.25-1.3 1-1.73L11 5.18V2.05h2z" />
        );

      case 'stepfun':
        return (
          <g>
            <rect x="3" y="14" width="4" height="4" rx="1" />
            <rect x="8.5" y="14" width="4" height="4" rx="1" />
            <rect x="8.5" y="8.5" width="4" height="4" rx="1" />
            <rect x="8.5" y="3" width="4" height="4" rx="1" />
            <rect x="14" y="3" width="4" height="4" rx="1" />
          </g>
        );

      case 'upstage':
        return (
          <g>
            <path d="M12 2.5L4 8.5l2.2 1.6L12 5.8l5.8 4.3L20 8.5 12 2.5z" />
            <path d="M12 8.5L4 14.5l2.2 1.6L12 11.8l5.8 4.3 2.2-1.6L12 8.5z" />
            <path d="M12 14.5L4 20.5l2.2 1.6 5.8-4.3 5.8 4.3 2.2-1.6L12 14.5z" />
          </g>
        );

      case 'writer':
        return (
          <path d="M2 4.5h3.5l4 11.5 3.5-10.5h2l3.5 10.5 4-11.5H22L17.5 19.5h-3L11 9.8l-3.5 9.7h-3L2 4.5z" />
        );

      case 'z-ai':
        return (
          <path d="M3 5.5h18v3.2H9.2l11.8 9.8V21H3v-3.2h11.8L3 8z" />
        );

      case 'qwen':
        return (
          <path d="M12 2L4 7v10l8 5 8-5V7l-8-5zm0 2.8l5.8 3.6v7.2L12 19.2l-5.8-3.6V8.4L12 4.8zm0 3.2L8.5 10v4l3.5 2 3.5-2v-4L12 8z" />
        );

      case 'anthropic':
        return (
          <path d="M13.8 3.5h3.4L24 20.5h-3.6l-1.5-3.6H12.9l-1.5 3.6H7.8L13.8 3.5zm2.7 10.8-2-4.9-2 4.9h4zM4.2 20.5 0 9.8h3.5l2.4 6.7 2.4-6.7h3.5l-4.2 10.7H4.2z" />
        );

      default:
        return (
          <g>
            <path d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.3l6.8 3.8v7.8L12 19.7 5.2 15.9V8.1L12 4.3z" />
            <circle cx="12" cy="12" r="3.5" />
          </g>
        );
    }
  };

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={fill}
      aria-hidden="true"
      className={`shrink-0 ${className} ${glow ? 'animate-glow-pulse' : ''}`}
      style={glow ? { filter: `drop-shadow(0 0 6px ${info.glowColor})` } : undefined}
    >
      {renderPath()}
    </svg>
  );
};
