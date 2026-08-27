// src/renderer/utils/provider-icon-map.ts
//
// Maps the NVIDIA NGC catalog `publisher` field (e.g. "nvidia", "meta",
// "z-ai") to a bundled SVG asset. SVGs are imported as URL strings via
// Vite's static-asset handling (see src/renderer/vite-env.d.ts).
//
// Sources & licenses (see report):
//   - nvidia, meta, google, mistral, minimaxai : Simple Icons (CC0 SVG traces;
//       underlying trademarks remain property of the respective companies —
//       bundled here under US nominative-fair-use for an Electron desktop app).
//   - openai                                  : Wikimedia Commons (PD textlogo).
//   - z-ai, stepfun-ai                         : official corporate brand assets.
//   - baai                                     : Wikimedia Commons (PD textlogo).

import nvidiaLogo from '../assets/providers/nvidia.svg';
import metaLogo from '../assets/providers/meta.svg';
import openaiLogo from '../assets/providers/openai.svg';
import googleLogo from '../assets/providers/google.svg';
import mistralLogo from '../assets/providers/mistral.svg';
import zAiLogo from '../assets/providers/z-ai.svg';
import stepfunLogo from '../assets/providers/stepfun-ai.svg';
import minimaxLogo from '../assets/providers/minimaxai.svg';
import baaiLogo from '../assets/providers/baai.svg';

const map: Record<string, string> = {
  nvidia: nvidiaLogo,
  meta: metaLogo,
  openai: openaiLogo,
  google: googleLogo,
  mistral: mistralLogo,
  'mistral-ai': mistralLogo, // alias — NVIDIA sometimes lists "mistral-ai"
  mistralai: mistralLogo, // alias — "mistralai" (no hyphen) variant
  'z-ai': zAiLogo,
  zai: zAiLogo, // alias — Z.ai short form
  zhipu: zAiLogo, // alias — Z.ai's former corporate name
  'zhipu-ai': zAiLogo,
  'stepfun-ai': stepfunLogo,
  stepfun: stepfunLogo, // alias
  minimaxai: minimaxLogo,
  minimax: minimaxLogo, // alias
  baai: baaiLogo,
  'b-aai': baaiLogo, // alias — hyphenated variant
};

/**
 * Returns the bundled SVG URL for a given publisher slug, or null when no
 * bundled asset is available (e.g. "microsoft", "eleuther", unknown vendor).
 */
export function providerIconUrl(publisher?: string | null): string | null {
  if (!publisher) return null;
  return map[publisher.toLowerCase()] ?? null;
}
