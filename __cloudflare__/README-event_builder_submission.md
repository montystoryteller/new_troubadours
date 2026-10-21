# Event builder -> GitHub submissions

Flow: builder page -> POST /api/submit -> Cloudflare Worker -> issue in
montystoryteller/newtroubadourssubmit -> GitHub Action -> submissions/<date>-issue-N.json

## Files
- worker/src/index.js, worker/wrangler.toml : the Cloudflare Worker
- .github/workflows/event-submission.yml    : goes in the GitHub repo
- event_builder.html                        : your builder with a "Send for review" button added

## 1. GitHub repo (montystoryteller/newtroubadourssubmit)
1. Add .github/workflows/event-submission.yml to the repo (commit to the default branch).
2. Issues > Labels > New label named exactly: event-submission
3. Settings > Actions > General > Workflow permissions > Read and write permissions > Save.
4. Settings (your account) > Developer settings > Personal access tokens > Fine-grained tokens:
   - Repository access: Only select repositories > newtroubadourssubmit
   - Permissions: Issues = Read and write (nothing else)
   - Copy the token.

## 2. Cloudflare Worker
1. Edit worker/wrangler.toml: replace both YOUR_DOMAIN with your domain
   (the DNS record must be proxied / orange cloud).
2. In the worker/ folder:
   npm i -D wrangler
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN     (paste the token)
   npx wrangler secret put SUBMIT_KEY       (any long random string; you'll type it into the page once)
   npx wrangler deploy

## 3. Builder page
Replace your event_builder.html with the one in this bundle (or copy the
submitOutput() function and the extra button into your own copy), then deploy the site as usual.

## 4. Test
curl -X POST https://YOUR_DOMAIN/api/submit \
  -H "X-Submit-Key: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"musicEvents":[{"test":true}]}'
Expect {"ok":true,"issue":N}, then a new file in submissions/ a minute later.
Delete the test file afterwards.

## Notes
- Max about 60,000 characters per submission (GitHub issue limit); send big batches in parts.
- If you add a new top-level output key to generateOutput() in the builder, add it to ALLOWED_KEYS in worker/src/index.js and redeploy.
- Change the submit key: run `npx wrangler secret put SUBMIT_KEY` again; the page will re-prompt after a 401.


https://claude.ai/chat/a4b6be6e-f6de-4111-ac35-11a8877ce86a