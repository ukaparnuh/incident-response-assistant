# Incident Response Assistant

A small incident pipeline on AWS. Alerts arrive through a webhook or CloudWatch, a rule-based analyser classifies and explains them, and humans resolve them from a dashboard. Customers following an incident in the demo shop see the resolution as soon as it is published.

## Repository layout

| Path | What it is |
| --- | --- |
| `incident-assistant/` | Backend: AWS SAM template, Lambda functions (`src/ingest`, `src/analyze`, `src/api`), tests |
| `incident-project/incident-dashboard/` | Admin dashboard (static site) |
| `incident-project/shop-demo/` | Demo storefront that reports checkout failures and shows incident updates |
| `incident-project/bucket-policy.json` | Public-read policy for the S3 bucket that hosts the frontends |

## How it works

1. A webhook `POST /alerts` (or a CloudWatch alarm) queues the alert on SQS.
2. The analyser assigns severity, a probable cause, and remediation steps, then stores the incident in DynamoDB. High and critical incidents also send an email through SNS.
3. Admins open an incident in the dashboard, tick off remediation steps, write what fixed it, and mark it resolved.
4. The Mini Shop polls `GET /status/{incident_id}` (public, no API key) and shows the status and the resolution note to the customer.

## Backend setup

Requirements: Python 3.12, the AWS SAM CLI, and AWS credentials for your own account. Credentials are read from your local AWS configuration and are never stored in this repository.

```bash
cd incident-assistant
sam build
sam deploy --guided   # enter your alert email when prompted
```

The template does not create an API key. After deploying:

1. In the API Gateway console, create an API key.
2. Add it to the usage plan `IncidentApiPlan` for the `incident-assistant` API stage `prod`.
3. Use that key as `apiKey` in the frontend configs below.

Run the tests (no AWS access needed):

```bash
pip install pytest boto3
python -m pytest
```

Send a sample alert once deployed (replace the placeholders):

```bash
curl -X POST "https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/prod/alerts" \
  -H "x-api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d @events/generic_alert.json
```

## Frontend setup

Each frontend reads its connection details from a local `config.js`, which is git-ignored.

```bash
cp incident-project/incident-dashboard/config.example.js incident-project/incident-dashboard/config.js
cp incident-project/shop-demo/config.example.js incident-project/shop-demo/config.js
```

Fill in `apiBase`, `apiKey`, and (for the shop) `dashboardUrl`. The dashboard can also be configured in the browser under **API settings**, which overrides `config.js`.

Hosting on S3 (static website hosting, public read):

1. Create a bucket and replace `YOUR_BUCKET` in `incident-project/bucket-policy.json`, then apply that policy.
2. Upload the shop to the bucket root: `index.html`, `styles.css`, `app.js`, `config.js`.
3. Upload the dashboard to the `dashboard/` prefix: `index.html`, `styles.css`, `app.js`, `config.js`. The shop's "View in incident dashboard" link expects this path.

## Security notes

- **The API key is visible to anyone who can load the frontends.** Both the dashboard and the shop run in the browser, so their `config.js` values are public. Treat the key as a low-privilege demo key. Before using this beyond a demo, put the dashboard behind real authentication (for example Amazon Cognito) and remove the key from the browser.
- `GET /status/{incident_id}` is intentionally public. Incident IDs are random UUIDs and the response contains only customer-safe fields.
- Never commit `config.js`, `.aws-sam/`, `samconfig.local.toml`, or any `.env` file.
