---
'@vercel/agent-eval': minor
---

Make classifier feature optional and add feature flag

**Features:**
- Added `isClassifierEnabled()` function to check if classifier is available (requires `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`)
- Classifier is now optional: if neither env var is set, classification is skipped and all results are preserved
- Warning message now displays when classifier is disabled, explaining why the keys are needed
- Updated README to document classifier behavior and environment variable requirements

**Changes:**
- CLI skips entire classification block when classifier is disabled
- Housekeeping no longer removes non-model failures when classifier is disabled (only removes incomplete/duplicate results)
- All tests updated to properly enable classifier for tests that require it
- Added test case for disabled classifier behavior
