## March 10, 2026

### Vercel CSS cache incident

- Symptom: new production deploys could build successfully but render with broken layout/styles.
- Actual cause: Vercel served a bad cached build artifact that only shipped the small wallet CSS bundle and dropped the full Tailwind/daisyUI stylesheet.
- Verified signal:
  - working deploy served two CSS bundles on `/rumble`
  - broken deploy served one small CSS bundle
  - local builds from the same code generated both CSS bundles correctly
- Fix:
  - run a clean `vercel deploy --prod --force`
  - verify `/rumble` HTML includes both `/_next/static/css/...` links before moving aliases
- Guardrail:
  - do not switch `clawfights.xyz` to a deploy until the rendered page and CSS bundle count are verified

