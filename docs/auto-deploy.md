# Auto-deploy from GitHub

Every push to `main` (in practice, every merged PR) runs CI. When the tests
pass, the `deploy` job in `.github/workflows/ci.yml` deploys to the
production Firebase project `fitness-app-47a06`:

1. `functions:auth` (the Node 22 sign-up trigger) first,
2. then `functions:default`, `hosting`, `firestore` (rules + indexes) and `storage` rules.

The job only runs while the repository variable `AUTO_DEPLOY` is `true`.

## How GitHub signs in to Google

There is no key or password stored in GitHub. GitHub gives each job a
short-lived token that says which repository and branch it came from.
Google's Workload Identity Federation checks that token and only accepts it
when it comes from the `main` branch of `hanstay/fitness-app` (repository id
`1330156129`, so a renamed or re-created repo with the same name isn't
trusted). The job then acts as the `github-deployer` service account, which
can deploy but has no access to your Google account and no read access to
Firestore data.

## One-time setup

### 1. Move the intervals.icu client secret into Secret Manager (on your PC)

CI has no `functions/.env` (it's gitignored), so the intervals.icu client
secret now lives in Secret Manager, like the Anthropic key. The client ID and
redirect URI aren't secret and are committed in
`functions/.env.fitness-app-47a06`. Do this **before merging**, because every
deploy, manual or automatic, now expects the secret to exist:

```powershell
npx firebase-tools functions:secrets:set INTERVALS_ICU_CLIENT_SECRET --project fitness-app-47a06
```

Paste the value of `INTERVALS_ICU_CLIENT_SECRET` from your local
`functions/.env` at the prompt. Then, on every machine you deploy from, move
the `INTERVALS_ICU_CLIENT_SECRET` line out of `functions/.env` into
`functions/.secret.local` (gitignored; the emulator reads secrets from it).
Firebase refuses a deploy where the same name is both a secret and a plain
variable. The client ID and redirect URI lines can stay.

Also set the container-image cleanup policy once (the CLI otherwise stops a
non-interactive deploy to ask about it):

```powershell
npx firebase-tools functions:artifacts:setpolicy --project fitness-app-47a06 --location us-central1 --force
npx firebase-tools functions:artifacts:setpolicy --project fitness-app-47a06 --location asia-southeast1 --force
```

### 2. Let GitHub deploy (Cloud Shell)

Run this in [Cloud Shell](https://console.cloud.google.com/?cloudshell=true&project=fitness-app-47a06)
(it has `gcloud` installed and is already signed in as you). It's safe to
paste in one go.

```bash
PROJECT_ID=fitness-app-47a06
PROJECT_NUMBER=39106506907
REPO_ID=1330156129
DEPLOYER=github-deployer@$PROJECT_ID.iam.gserviceaccount.com

gcloud config set project $PROJECT_ID
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com

# Trust GitHub's tokens, but only from this repo's main branch.
gcloud iam workload-identity-pools create github \
  --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc fitness-app \
  --location=global --workload-identity-pool=github \
  --display-name="hanstay/fitness-app" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository_id == '$REPO_ID' && assertion.ref == 'refs/heads/main'"

# The account deploys run as.
gcloud iam service-accounts create github-deployer \
  --display-name="GitHub Actions deployer"
gcloud iam service-accounts add-iam-policy-binding $DEPLOYER \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$REPO_ID"

# What it may deploy.
for ROLE in \
  roles/cloudfunctions.admin \
  roles/run.admin \
  roles/cloudscheduler.admin \
  roles/firebasehosting.admin \
  roles/firebaserules.admin \
  roles/datastore.indexAdmin \
  roles/secretmanager.viewer \
  roles/artifactregistry.reader \
  roles/serviceusage.serviceUsageConsumer
do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$DEPLOYER" --role=$ROLE --condition=None --quiet >/dev/null
done

# Let it deploy functions that run as the default runtime accounts
# (2nd gen: compute; the 1st-gen auth trigger: App Engine).
for SA in $PROJECT_NUMBER-compute@developer.gserviceaccount.com $PROJECT_ID@appspot.gserviceaccount.com; do
  gcloud iam service-accounts add-iam-policy-binding $SA \
    --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser --quiet >/dev/null
done

# The functions read these secrets at runtime. Granting it here up front means
# the deployer only has to check the binding, not change it.
for SECRET in ANTHROPIC_API_KEY INTERVALS_ICU_CLIENT_SECRET; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done
echo "Done."
```

### 3. Switch it on

In GitHub: **Settings → Secrets and variables → Actions →
Variables → New repository variable**, name `AUTO_DEPLOY`, value `true`.

To check it works without waiting for a PR, open the latest CI run on `main`
under the Actions tab and click **Re-run all jobs**.

## When a deploy fails

- **Permission denied** (`... does not have permission ...` / `403`): the log
  names the missing permission. Grant the role that holds it to
  `github-deployer` with the same `add-iam-policy-binding` command, then
  re-run the job.
- **New secret**: when a function starts using a new secret, set it with
  `functions:secrets:set` and grant the compute account access with the
  `gcloud secrets add-iam-policy-binding` line above, before merging.
- **Would delete a function**: the deploy refuses on purpose rather than
  delete a function unattended. Run that one deploy yourself
  (`npx firebase-tools deploy --project fitness-app-47a06`), then later merges
  deploy normally.
- **Bad change reached production**: revert the PR on GitHub; merging the
  revert deploys the previous code. Hosting alone can also be rolled back in
  the Firebase console (Hosting → release history). Don't use **Re-run** on
  an old CI run to roll back: it redeploys that run's code, including its
  functions and rules, which is easy to do by accident.

## Switching it off

Delete the `AUTO_DEPLOY` variable (or set it to anything but `true`). Manual
deploys from any up-to-date clone keep working either way.
