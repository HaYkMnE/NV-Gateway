// Single source of truth for the renderer i18n key contract
// (src/renderer/i18n/resources.ts). Every test that pins the per-locale key
// count imports it from here; tests/i18n-contract.test.mjs enforces the
// contract and fails if a test hard-codes the current count instead.
//
// Adding a UI string: define the key in all 7 locales in resources.ts, bump
// EXPECTED_LOCALE_KEY_COUNT below (append a lineage line), and update the
// count mentioned in AGENTS.md (Localization rule).

/** The 7 shipped locales, in resources.ts / i18n/config.ts order. */
export const LOCALE_NAMES = Object.freeze(['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar']);

// Key-set lineage (merged from the comments the pin tests used to carry; the
// per-change detail is in git history):
//   302  earlier feedback / model-label work
//   306  +1 runtime_exit, +3 context-specific dialog close labels
//   319  +13 Models «Details» drawer (2 section headings, 6 technical
//        rows/labels, 2 availability values, 2 metric rows, 1 small-print line)
//   326  +7 Round 1b technical rows (context length, max output, capabilities,
//        reasoning, control key, vision, tools)
//   331  +5 Round E (the «Топовые» "top" sort label, the "Data by LLM Stats"
//        attribution, the strength rank / source / unranked rows)
//   334  +3 Day/Night/Auto hover tooltips (mode_day_help, mode_night_help,
//        mode_auto_help)
//   333  -1 Round E cleanup: the dead models_info_strength_unranked key (its
//        "Not ranked" placeholder row was deleted, nothing referenced it)
//   330  -3 owner removed the "minimum popularity" row
//        (models_filter_popularity_label / _any / _threshold)
//   338  +8 Е-1b Settings «Request deadline» (deadline_label / _help /
//        _required / _integer / _range / _env_override / _saved / _save_error)
//   340  +2 Dashboard legacy-disabled hint (key_legacy_disabled,
//        keys_legacy_summary)
//   351  +11 6B pet advisor (tip_*, settings_tips*)
//   354  +3 6C settings info-tips (infotip_*)
//   356  +2 Settings LLM Stats ranking switch (settings_llm_stats, _help)
//   358  +2 Models collapsible tag toggle (models_filter_labels_count, _selected)
//   357  -1 CR7-009 fake Settings "Reset to Defaults" removed (models_reset)
//   359  +2 Endpoint snippet title + OpenCode merge hint
//        (endpoint_config_snippet_title, endpoint_opencode_hint)
//   370  +12 Endpoint "Works with any app" (endpoint_universal_title,
//        endpoint_base_url_openai / _anthropic, endpoint_group_file / _env / _ui,
//        6 endpoint_steps_<client>), -1 endpoint_base_url (replaced by the two)
//   462  +92 W4: CLDR plural forms for the 15 existing {{count}} keys (6
//        categories x 15 keys, added in all 7 locales) and +2 renderer error
//        boundary strings (render_crash, render_crash_hint)
//   463  +1 W4 correction: endpoint_copy_unresolved (copy is refused while the
//        gateway token or model is unresolved)
//   464  +1 W4d: endpoint_creds_error (a failed gateway-credentials fetch is
//        reported as a token failure, not as a keys-list failure)
//   561  464 + 97 pet spec 2026-10-26 (captions, hint, random tips)
//   557  -4 pet spec part E2: removed pet_cta_main/pet_cta_sub/pet_jar_title/pet_jar_subtitle
/** Exact number of keys every locale in resources.ts must hold. */
export const EXPECTED_LOCALE_KEY_COUNT = 557;
