export type PetState =
  | 'power_nap'
  | 'terminal_nap'
  | 'low_battery'
  | 'empty_mug'
  | 'code_frenzy'
  | 'bug_hunter'
  | 'bug_slayer'
  | 'coin_drop'
  | 'nano_coffee'
  | 'turbine_generator'
  | 'sensor_polish'
  | 'model_juggler'
  | 'zero_errors'
  | 'flowchart'
  | 'syndicate_salute'
  | 'espresso_toast'
  | 'fourth_wall_wink'
  | 'hyper_hack'
  | 'quantum_meditation';

export interface PetConfig {
  name: string;
  vipStatus: boolean;
  soundEnabled: boolean;
  totalDonationsCount: number;
  lastState: PetState;
}

const STORAGE_KEY = 'nv_cyber_pet_config';

export function loadPetConfig(): PetConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}

  return {
    name: 'GigaNvidiaCat',
    vipStatus: false,
    soundEnabled: true,
    totalDonationsCount: 0,
    lastState: 'code_frenzy',
  };
}

export function savePetConfig(cfg: PetConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
}

export function pickRandomState(isVip: boolean): PetState {
  const normalStates: PetState[] = [
    'code_frenzy',
    'bug_hunter',
    'bug_slayer',
    'empty_mug',
    'nano_coffee',
    'terminal_nap',
    'power_nap',
    'model_juggler',
    'zero_errors',
    'flowchart',
    'low_battery',
    'sensor_polish',
  ];

  const vipStates: PetState[] = [
    'syndicate_salute',
    'espresso_toast',
    'fourth_wall_wink',
    'hyper_hack',
    'quantum_meditation',
    'turbine_generator',
  ];

  const pool = isVip ? [...normalStates, ...vipStates, ...vipStates] : normalStates;
  return pool[Math.floor(Math.random() * pool.length)];
}
