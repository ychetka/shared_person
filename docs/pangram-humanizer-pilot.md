# Pangram humanizer pilot — three-variant validation (task 321)

Decision document for the content pipeline. Question: can AI-generated
or AI-edited text pass the Pangram AI detector at the moderation gate,
and which production pattern is viable?

Budget: ~22 calls approved of the 40-call cap; 7 spent in this round
(plus 18 in earlier stages). All artifacts (variant texts, scan JSON,
ledger) live in the untracked runtime dir `.devin/pilot_pangram/` —
corpus-derived texts contain personal writing and are not committed.

## Method

Three variants per the approved plan, all scanned via the direct API
transport (`tools/pangram_api.js`, `pangram-4` model, `version: 4.1`):

- **HUMAN-CORE**: real human-authored text from the developer's voice
  corpus (rucom forum posts, 558w and 389w samples), then AI-polished
  at two intensities. Hypothesis: human core stays human after polish.
- **MANUAL-POLISH** (reverse): a canonical-LLM draft handed to the
  developer for manual polishing — pending developer input.
- **VOICE-MIMIC**: AI-generated article conditioned on the developer's
  register (lowercase starts, telegraphic style, typos, jargon,
  parentheticals) extracted from the corpus.

## Results

| Variant | Sample | Pangram verdict | score |
|---|---|---|---|
| HUMAN-CORE | hc_v0 raw post (558w) | Human Written | ~0% (7.5e-14) |
| HUMAN-CORE | hc_v1 light polish (~15-20% edits) | Human Written | ~0% (2.7e-13) |
| HUMAN-CORE | hc_v2 deep rewrite (~50%, bullets -> prose) | Human Written | ~0% (2.0e-25) |
| HUMAN-CORE | hc_b0 second post (389w, robustness check) | Human Written | ~0% (1.2e-25) |
| VOICE-MIMIC | vm_v1 register imitation (275w) | AI Generated | 100% (1.0) |
| VOICE-MIMIC | vm_v2 deeper humanization (303w) | AI Generated | 100% (1.0) |
| MANUAL-POLISH | mp_draft machine baseline (234w) | AI Generated | 100% (1.0) |
| MANUAL-POLISH | mp_v1 developer-polished | *pending input* | — |

Earlier-stage evidence consistent with this result:

- 5/5 real pre-LLM Habr articles: Human Written ~0% (control baseline).
- All LLM drafts (real_draft, ai_flop, borderline) scored 100% AI and
  did not move across 4 legitimate edit iterations.
- 85% human + ~15% AI polish hybrid scored Human Written ~0%.
- The `clean_human` fixture is synthetic — it scores 100% AI and must
  not be used as a human control.

## Conclusions

1. **HUMAN-CORE confirmed, stronger than expected.** Not only light
   polish (~15-20%) but a ~50% restructure into flowing prose keeps
   the document Human at ~0%. The detector weights document-level
   provenance far above surface edits; human-authored informational
   structure survives heavy AI rewording.
2. **VOICE-MIMIC failed.** Style conditioning (register, typos,
   telegraphic rhythm) does not transfer human-ness — both iterations
   saturated at 100% AI. Mimicking the author's voice is not a path
   around the detector.
3. **MANUAL-POLISH pending.** Machine draft confirmed 100% AI; the
   developer's polished version will be scanned on arrival — this is
   the decisive datapoint for "machine draft + human polish".

## Recommended pipeline pattern

- Viable: **human-authored core -> AI expansion/polish -> human
  moderation.** The developer writes the factual/narrative core
  (bullets, voice notes, draft), AI expands and polishes, moderation
  gate stays mandatory.
- Not viable: AI draft -> automated humanizer -> publish. Detector
  rejects it regardless of iteration depth or voice conditioning.

## Open items

- `mp_v1` developer-polished score (bridge ask pending).
- If mp_v1 lands Human, the manual-polish path becomes a documented
  escape hatch for fully-machine drafts; if AI, the human-core pattern
  is the only viable production path.
- Second-detector transfer check still outstanding per the original
  stage-3 plan.
